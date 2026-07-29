import path from 'node:path';
import util from 'node:util';
import { CLIError } from '../../utils/errors';
import type { RequestOptions } from '../../utils/metro-compat';
import { Server } from '../../utils/metro-compat';
import { getFederationBuildSession } from '../../federation-build-session';
import type { Config } from '../types';
import { createResolver } from '../utils/create-resolver';
import { getCommunityCliPlugin } from '../utils/get-community-plugin';
import loadMetroConfig from '../utils/load-metro-config';
import { saveBundleAndMap } from '../utils/save-bundle-and-map';
import { toPosixPath } from '../../plugin/helpers';
import type {
  FederatedBundleCommand,
  FederatedBundleContext,
} from '../federated-bundle-command';
import type { BundleFederatedHostArgs } from './types';

async function executeFederatedHost({
  cfg,
  args,
  metroConfig: config,
}: FederatedBundleContext<BundleFederatedHostArgs>): Promise<void> {
  const logger = cfg.logger ?? console;
  const session = getFederationBuildSession(config);
  if (!session) {
    logger.error(
      `${util.styleText('red', 'error')} Cannot determine the host entrypoint path.`,
    );
    throw new CLIError('Bundling failed');
  }

  session.originalEntryPath = path.resolve(config.projectRoot, args.entryFile);
  const hostEntryFilepath = session.hostEntryPath;
  const bundleArgs = {
    ...args,
    entryFile: hostEntryFilepath,
  };

  const communityCliPlugin = getCommunityCliPlugin(cfg.reactNativePath);

  const buildBundleWithConfig =
    communityCliPlugin.unstable_buildBundleWithConfig;

  return buildBundleWithConfig(bundleArgs, config, {
    build: async (server: Server, requestOpts: RequestOptions) => {
      // setup enhance middleware to trigger virtual modules setup
      config.server.enhanceMiddleware(server.processRequest, server);
      const resolver = await createResolver(server, bundleArgs.platform);
      // hack: resolve the host entry to register it as a virtual module
      const relativeHostEntryPath = toPosixPath(
        path.relative(config.projectRoot, hostEntryFilepath),
      );
      resolver.resolve({
        from: config.projectRoot,
        to: `./${relativeHostEntryPath}`,
      });

      return server.build({
        ...Server.DEFAULT_BUNDLE_OPTIONS,
        ...requestOpts,
      });
    },
    save: saveBundleAndMap,
    formatName: 'bundle',
  });
}

async function bundleFederatedHostCommand(
  _argv: Array<string>,
  cfg: Config,
  args: BundleFederatedHostArgs,
): Promise<void> {
  const metroConfig = await loadMetroConfig(cfg, {
    maxWorkers: args.maxWorkers,
    resetCache: args.resetCache,
    config: args.config,
  });
  return executeFederatedHost({ cfg, args, metroConfig });
}

const bundleFederatedHost: FederatedBundleCommand<BundleFederatedHostArgs> =
  Object.assign(bundleFederatedHostCommand, {
    executeWithConfig: executeFederatedHost,
  });

export default bundleFederatedHost;

export { default as bundleFederatedHostOptions } from './options';
