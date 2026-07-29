import path from 'node:path';
import { promises as fs } from 'node:fs';
import util from 'node:util';
import type { ConfigT } from 'metro-config';
import type {
  ModuleFederationConfig,
  ModuleFederationConfigNormalized,
  ModuleFederationExtraOptions,
} from '../types';
import { VirtualModuleManager } from '../utils';
import {
  applyTypesMetaToManifest,
  maybeGenerateFederatedRemoteTypes,
} from '../utils/federated-remote-types';
import {
  FEDERATION_BUILD_SESSION,
  type FederationBuildSession,
} from '../federation-build-session';
import { createBabelTransformer } from './babel-transformer';
import {
  isUsingMFBundleCommand,
  isUsingMFCommand,
  prepareTmpDir,
  replaceExtension,
  stubHostEntry,
  stubRemoteEntry,
} from './helpers';
import { createManifest } from './manifest';
import { createManifestMiddleware } from './manifest-middleware';
import { normalizeExtraOptions } from './normalize-extra-options';
import { normalizeOptions } from './normalize-options';
import { createResolveRequest } from './resolver';
import { createRewriteRequest } from './rewrite-request';
import { getModuleFederationSerializer } from './serializer';
import { validateOptions } from './validate-options';

export function withModuleFederation(
  config: ConfigT,
  federationOptions: ModuleFederationConfig,
  extraOptions?: ModuleFederationExtraOptions,
): ConfigT {
  if (isUsingMFCommand()) {
    return augmentConfig(config, federationOptions, extraOptions);
  }

  console.warn(
    util.styleText(
      'yellow',
      'Warning: Module Federation build is disabled for this command.\n',
    ) +
      util.styleText(
        'yellow',
        'To enable Module Federation, please use one of the dedicated bundle commands:\n',
      ) +
      ` ${util.styleText('dim', '•')} bundle-mf-host` +
      util.styleText('dim', ' - for bundling a host application\n') +
      ` ${util.styleText('dim', '•')} bundle-mf-remote` +
      util.styleText('dim', ' - for bundling a remote application\n'),
  );

  return config;
}

function augmentConfig(
  config: ConfigT,
  federationOptions: ModuleFederationConfig,
  extraOptions?: ModuleFederationExtraOptions,
): ConfigT {
  const isHost = !federationOptions.exposes;
  const isRemote = !isHost;

  const tmpDirPath = prepareTmpDir(config.projectRoot);

  validateOptions(federationOptions);

  const options = normalizeOptions(federationOptions, {
    projectRoot: config.projectRoot,
    tmpDirPath,
  });

  const { flags } = normalizeExtraOptions(extraOptions);

  const vmManager = new VirtualModuleManager(config);

  // original host entrypoint, usually <projectRoot>/index.js
  const originalEntryFilename = 'index.js';
  const originalEntryPath = path.resolve(
    config.projectRoot,
    originalEntryFilename,
  );

  // virtual host entrypoint
  const hostEntryFilename = 'host-entry.js';
  const hostEntryPath = path.resolve(tmpDirPath, hostEntryFilename);

  // virtual remote entrypoint
  const remoteEntryFilename = replaceExtension(options.filename, '.js');
  const remoteEntryPath = path.resolve(tmpDirPath, remoteEntryFilename);

  // other virtual modules
  const initHostPath = path.resolve(tmpDirPath, 'init-host.js');
  const remoteHMRSetupPath = path.resolve(tmpDirPath, 'remote-hmr.js');
  const remoteModuleRegistryPath = path.resolve(
    tmpDirPath,
    'remote-module-registry.js',
  );

  const asyncRequirePath = require.resolve('../modules/asyncRequire.ts');

  const babelTransformerPath = createBabelTransformer({
    blacklistedPaths: [initHostPath, remoteEntryPath],
    federationConfig: options,
    originalBabelTransformerPath: config.transformer.babelTransformerPath,
    tmpDirPath: tmpDirPath,
    enableInitializeCorePatching: flags.unstable_patchInitializeCore,
    enableRuntimeRequirePatching: flags.unstable_patchRuntimeRequire,
  });

  const manifestOptions = {
    projectRoot: config.projectRoot,
    target: isUsingMFBundleCommand() ? 'build' : 'development',
    tmpDirPath,
  } as const;
  const manifestPath = createManifest(options, tmpDirPath, manifestOptions);

  // host and remote entries are entry points, so they need to be present in the filesystem
  // we create stubs on the filesystem and then redirect corresponding virtual modules
  stubHostEntry(hostEntryPath);
  stubRemoteEntry(remoteEntryPath);

  const session: FederationBuildSession = {
    federationConfig: options,
    originalEntryPath,
    hostEntryPath,
    remoteEntryPath,
    manifestPath,
    tmpDirPath,
  };

  maybeGenerateRemoteTypesForStart({
    isRemote,
    options,
    projectRoot: config.projectRoot,
    tmpDirPath,
    manifestPath,
    session,
  });

  const augmentedConfig = {
    ...config,
    [FEDERATION_BUILD_SESSION]: session,
    serializer: {
      ...config.serializer,
      customSerializer: getModuleFederationSerializer(
        options,
        isUsingMFBundleCommand(),
        manifestPath,
        manifestOptions,
      ),
      getModulesRunBeforeMainModule: (entryFilePath) => {
        // skip altering the list of modules when unstable_patchInitializeCore is enabled
        if (flags.unstable_patchInitializeCore) {
          return config.serializer.getModulesRunBeforeMainModule(entryFilePath);
        }
        // remove existing pre-modules like InitializeCore for remote entrypoints
        if (isRemote) {
          return [];
        }
        // prepend init-host to the list of modules to ensure it's run first
        return [
          initHostPath,
          ...config.serializer.getModulesRunBeforeMainModule(entryFilePath),
        ];
      },
      getRunModuleStatement: (moduleId: number | string) => {
        return `${options.name}__r(${JSON.stringify(moduleId)});`;
      },
      getPolyfills: (options) => {
        return isHost ? config.serializer.getPolyfills(options) : [];
      },
    },
    transformer: {
      ...config.transformer,
      globalPrefix: options.name,
      babelTransformerPath: babelTransformerPath,
      getTransformOptions: vmManager.getTransformOptions(),
    },
    resolver: {
      ...config.resolver,
      resolveRequest: createResolveRequest({
        isRemote,
        vmManager,
        options,
        paths: {
          asyncRequire: asyncRequirePath,
          getOriginalEntry: () => session.originalEntryPath,
          hostEntry: hostEntryPath,
          initHost: initHostPath,
          remoteModuleRegistry: remoteModuleRegistryPath,
          remoteHMRSetup: remoteHMRSetupPath,
          remoteEntry: remoteEntryPath,
          projectDir: config.projectRoot,
          tmpDir: tmpDirPath,
        },
        hacks: {
          patchHMRClient: flags.unstable_patchHMRClient,
          patchInitializeCore: flags.unstable_patchInitializeCore,
        },
        customResolver: config.resolver.resolveRequest,
      }),
    },
    server: {
      ...config.server,
      enhanceMiddleware: (middleware, metroServer) => {
        const manifestMiddleware = createManifestMiddleware({
          federationConfig: options,
          projectRoot: config.projectRoot,
          remoteEntryPath,
          tmpDirPath,
          vmManager,
        })(middleware, metroServer);
        return vmManager.getMiddleware()(manifestMiddleware, metroServer);
      },
      rewriteRequestUrl: createRewriteRequest({
        config,
        originalEntryFilename,
        remoteEntryFilename,
        manifestPath,
        tmpDirPath,
        getDtsAssetNames: () => session.dtsAssets,
      }),
    },
  };

  return augmentedConfig;
}

function maybeGenerateRemoteTypesForStart(opts: {
  isRemote: boolean;
  options: ModuleFederationConfigNormalized;
  projectRoot: string;
  tmpDirPath: string;
  manifestPath: string;
  session: FederationBuildSession;
}) {
  if (process.argv[2] !== 'start') {
    return;
  }
  if (!opts.isRemote || opts.options.dts === false) {
    return;
  }

  void (async () => {
    try {
      const typesMeta = await maybeGenerateFederatedRemoteTypes({
        federationConfig: opts.options,
        projectRoot: opts.projectRoot,
        outputDir: opts.tmpDirPath,
        logger: console,
      });

      if (!typesMeta) {
        return;
      }

      opts.session.dtsAssets = typesMeta;
      const manifest = JSON.parse(
        await fs.readFile(opts.manifestPath, 'utf-8'),
      ) as Record<string, any>;
      applyTypesMetaToManifest(manifest, typesMeta);
      await fs.writeFile(
        opts.manifestPath,
        JSON.stringify(manifest, undefined, 2),
        'utf-8',
      );
    } catch (error) {
      console.warn(
        `${util.styleText('yellow', 'Failed to generate federated types for dev server:')}\n${String(error)}`,
      );
    }
  })();
}
