import { promises as fs } from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { mergeConfig } from 'metro';
import { getFederationBuildSession } from '../../federation-build-session';
import { CLIError } from '../../utils/errors';
import {
  applyTypesMetaToManifest,
  maybeGenerateFederatedRemoteTypes,
} from '../../utils/federated-remote-types';
import { Server } from '../../utils/metro-compat';
import type { Config } from '../types';
import { createModulePathRemapper } from '../utils/create-module-path-remapper';
import { createResolver } from '../utils/create-resolver';
import loadMetroConfig from '../utils/load-metro-config';
import { saveBundleAndMap } from '../utils/save-bundle-and-map';
import type {
  FederatedBundleCommand,
  FederatedBundleContext,
} from '../federated-bundle-command';

import {
  createRemoteBundleRequests,
  type RemoteBundleRequest,
} from './create-bundle-requests';
import type { BundleFederatedRemoteArgs } from './types';

const DEFAULT_OUTPUT = 'dist';

async function buildBundle(
  server: Server,
  requestOpts: RemoteBundleRequest['requestOpts'],
) {
  const bundle = await server.build({
    ...Server.DEFAULT_BUNDLE_OPTIONS,
    ...requestOpts,
  });

  return bundle;
}

async function executeFederatedRemote({
  cfg,
  args,
  metroConfig: rawConfig,
}: FederatedBundleContext<BundleFederatedRemoteArgs>): Promise<void> {
  const logger = cfg.logger ?? console;
  const session = getFederationBuildSession(rawConfig);
  if (!session) {
    logger.error(
      `${util.styleText('red', 'error')} Module Federation configuration is missing.`,
    );
    logger.info(
      "Import the plugin 'withModuleFederation' " +
        "from '@module-federation/metro' package " +
        'and wrap your final Metro config with it.',
    );
    throw new CLIError('Bundling failed');
  }
  const {
    federationConfig,
    remoteEntryPath: containerEntryFilepath,
    manifestPath: manifestFilepath,
  } = session;

  if (rawConfig.resolver.platforms.indexOf(args.platform) === -1) {
    logger.error(
      `${util.styleText('red', 'error')}: Invalid platform ${
        args.platform ? `"${util.styleText('bold', args.platform)}" ` : ''
      }selected.`,
    );

    logger.info(
      `Available platforms are: ${rawConfig.resolver.platforms
        .map((x) => `"${util.styleText('bold', x)}"`)
        .join(
          ', ',
        )}. If you are trying to bundle for an out-of-tree platform, it may not be installed.`,
    );

    throw new CLIError('Bundling failed');
  }

  // This is used by a bazillion of npm modules we don't control so we don't
  // have other choice than defining it as an env variable here.
  process.env.NODE_ENV = args.dev ? 'development' : 'production';

  // wrap the resolveRequest with our own remapper
  // to replace the paths of remote/shared modules
  const modulePathRemapper = createModulePathRemapper();

  const config = mergeConfig(rawConfig, {
    resolver: {
      // remap the paths of remote & shared modules to prevent raw project paths
      // ending up in the bundles e.g. ../../node_modules/lodash.js -> shared/lodash.js
      resolveRequest: (context, moduleName, platform) => {
        // always defined since we define it in the MF plugin
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const originalResolveRequest = rawConfig.resolver!.resolveRequest!;
        const res = originalResolveRequest(context, moduleName, platform);
        return modulePathRemapper.remap(res);
      },
    },
    serializer: {
      // since we override the paths of split modules, we need to remap the module ids
      // back to the original paths, so that they point to correct modules in runtime
      // note: the split modules become separate entrypoints, and entrypoints are not
      // resolved using the metro resolver, so the only way is to remap the module ids
      createModuleIdFactory: () => {
        const factory = rawConfig.serializer.createModuleIdFactory();
        return (path: string) => factory(modulePathRemapper.reverse(path));
      },
    },
  });

  const server = new Server(config);

  // hack: setup enhance middleware to trigger virtual modules setup
  config.server.enhanceMiddleware(server.processRequest, server);

  const resolver = await createResolver(server, args.platform);

  const outputDir = args.output
    ? path.resolve(path.join(args.output, args.platform))
    : path.resolve(
        config.projectRoot,
        path.join(DEFAULT_OUTPUT, args.platform),
      );

  const requests = createRemoteBundleRequests({
    args,
    containerEntryFilepath,
    federationConfig,
    modulePathRemapper,
    outputDir,
    projectRoot: config.projectRoot,
    resolver,
  });

  try {
    logger.info(
      `${util.styleText('blue', 'Processing remote container and exposed modules')}`,
    );

    for (const { requestOpts, saveBundleOpts, targetDir } of requests) {
      // ensure output directory exists
      await fs.mkdir(targetDir, { recursive: true, mode: 0o755 });
      const bundle = await buildBundle(server, requestOpts);
      await saveBundleAndMap(bundle, saveBundleOpts, logger.info);

      // Save the assets of the bundle
      // const outputAssets = await server.getAssets({
      //   ...Server.DEFAULT_BUNDLE_OPTIONS,
      //   ...requestOpts,
      // });

      // When we're done saving bundle output and the assets, we're done.
      // return await saveAssets(
      //   outputAssets,
      //   args.platform,
      //   args.assetsDest,
      //   args.assetCatalogDest
      // );
    }

    const manifestOutputFilepath = path.resolve(outputDir, 'mf-manifest.json');

    // Intentional: type assets are generated during remote bundling because
    // they describe the remote container artifacts emitted by this command.
    const typesMeta = await maybeGenerateFederatedRemoteTypes({
      federationConfig,
      projectRoot: config.projectRoot,
      outputDir,
      logger,
    });

    logger.info(`${util.styleText('blue', 'Processing manifest')}`);
    const rawManifest = JSON.parse(
      await fs.readFile(manifestFilepath, 'utf-8'),
    );
    applyTypesMetaToManifest(rawManifest, typesMeta);

    await fs.writeFile(
      manifestOutputFilepath,
      JSON.stringify(rawManifest, undefined, 2),
      'utf-8',
    );
    logger.info(
      `Done writing MF Manifest to:\n${util.styleText('dim', manifestOutputFilepath)}`,
    );
  } finally {
    // incomplete types - this should be awaited
    await server.end();
  }
}

async function bundleFederatedRemoteCommand(
  _argv: Array<string>,
  cfg: Config,
  args: BundleFederatedRemoteArgs,
): Promise<void> {
  const metroConfig = await loadMetroConfig(cfg, {
    maxWorkers: args.maxWorkers,
    resetCache: args.resetCache,
    config: args.config,
  });
  return executeFederatedRemote({ cfg, args, metroConfig });
}

const bundleFederatedRemote: FederatedBundleCommand<BundleFederatedRemoteArgs> =
  Object.assign(bundleFederatedRemoteCommand, {
    executeWithConfig: executeFederatedRemote,
  });

export default bundleFederatedRemote;

export { default as bundleFederatedRemoteOptions } from './options';
