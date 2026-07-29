import path from 'node:path';
import type { FederationBuildSession } from '../../federation-build-session';
import type { OutputOptions, RequestOptions } from '../../utils/metro-compat';
import { toPosixPath } from '../../plugin/helpers';
import type { createModulePathRemapper } from '../utils/create-module-path-remapper';
import type { createResolver } from '../utils/create-resolver';
import {
  normalizeOutputRelativePath,
  toFileSourceUrl,
} from '../utils/path-utils';

import type { BundleFederatedRemoteArgs } from './types';

interface ModuleDescriptor {
  [moduleName: string]: {
    isContainerModule?: boolean;
    moduleInputFilepath: string;
    moduleOutputDir: string;
  };
}

interface BundleRequestOptions extends RequestOptions {
  lazy: boolean;
  modulesOnly: boolean;
  runModule: boolean;
  sourceUrl: string;
}

export interface RemoteBundleRequest {
  targetDir: string;
  requestOpts: BundleRequestOptions;
  saveBundleOpts: OutputOptions;
}

interface CreateRemoteBundleRequestsOptions {
  args: BundleFederatedRemoteArgs;
  containerEntryFilepath: string;
  federationConfig: FederationBuildSession['federationConfig'];
  modulePathRemapper: ReturnType<typeof createModulePathRemapper>;
  outputDir: string;
  projectRoot: string;
  resolver: Awaited<ReturnType<typeof createResolver>>;
}

function getRequestOpts(
  args: BundleFederatedRemoteArgs,
  opts: {
    isContainerModule: boolean;
    entryFile: string;
    sourceUrl: string;
    sourceMapUrl: string;
  },
): BundleRequestOptions {
  return {
    dev: args.dev,
    minify: args.minify !== undefined ? args.minify : !args.dev,
    platform: args.platform,
    entryFile: opts.entryFile,
    sourceUrl: opts.sourceUrl,
    sourceMapUrl: opts.sourceMapUrl,
    lazy: opts.isContainerModule,
    runModule: opts.isContainerModule,
    modulesOnly: !opts.isContainerModule,
  };
}

function getSaveBundleOpts(
  args: BundleFederatedRemoteArgs,
  opts: {
    bundleOutput: string;
    sourcemapOutput: string;
  },
): OutputOptions {
  return {
    indexedRamBundle: false,
    bundleEncoding: args.bundleEncoding,
    dev: args.dev,
    platform: args.platform,
    sourcemapSourcesRoot: args.sourcemapSourcesRoot,
    sourcemapUseAbsolutePath: args.sourcemapUseAbsolutePath,
    bundleOutput: opts.bundleOutput,
    sourcemapOutput: opts.sourcemapOutput,
  };
}

export function createRemoteBundleRequests({
  args,
  containerEntryFilepath,
  federationConfig,
  modulePathRemapper,
  outputDir,
  projectRoot,
  resolver,
}: CreateRemoteBundleRequestsOptions): RemoteBundleRequest[] {
  const containerModule: ModuleDescriptor = {
    [federationConfig.filename]: {
      moduleInputFilepath: containerEntryFilepath,
      moduleOutputDir: outputDir,
      isContainerModule: true,
    },
  };

  const relativeContainerEntryPath = toPosixPath(
    path.relative(projectRoot, containerEntryFilepath),
  );
  resolver.resolve({
    from: projectRoot,
    to: `./${relativeContainerEntryPath}`,
  });

  const exposedModules = Object.entries(federationConfig.exposes)
    .map(([moduleName, moduleFilepath]) => [
      moduleName.slice(2),
      moduleFilepath,
    ])
    .reduce((acc, [moduleName, moduleInputFilepath]) => {
      acc[moduleName] = {
        moduleInputFilepath: path.resolve(projectRoot, moduleInputFilepath),
        moduleOutputDir: path.resolve(outputDir, 'exposed'),
        isContainerModule: false,
      };
      return acc;
    }, {} as ModuleDescriptor);

  const sharedModules = Object.entries(federationConfig.shared)
    .filter(([, sharedConfig]) => {
      return !sharedConfig.eager && sharedConfig.import !== false;
    })
    .reduce((acc, [moduleName]) => {
      const inputFilepath = resolver.resolve({
        from: containerEntryFilepath,
        to: moduleName,
      });
      acc[moduleName] = {
        moduleInputFilepath: inputFilepath,
        moduleOutputDir: path.resolve(outputDir, 'shared'),
        isContainerModule: false,
      };
      return acc;
    }, {} as ModuleDescriptor);

  return Object.entries({
    ...containerModule,
    ...exposedModules,
    ...sharedModules,
  }).map(
    ([
      moduleName,
      { moduleInputFilepath, moduleOutputDir, isContainerModule = false },
    ]) => {
      const moduleBundleName = isContainerModule
        ? moduleName
        : `${moduleName}.bundle`;
      const moduleBundleFilepath = path.resolve(
        moduleOutputDir,
        moduleBundleName,
      );
      const relativeModuleBundlePath = normalizeOutputRelativePath(
        path.relative(outputDir, moduleBundleFilepath),
      );
      const moduleBundleUrl = toFileSourceUrl(relativeModuleBundlePath);
      const moduleSourceMapFilepath = path.resolve(
        moduleOutputDir,
        `${moduleBundleName}.map`,
      );
      const moduleSourceMapUrl = normalizeOutputRelativePath(
        path.relative(outputDir, moduleSourceMapFilepath),
      );

      if (!isContainerModule) {
        modulePathRemapper.addMapping(
          moduleInputFilepath,
          relativeModuleBundlePath,
        );
      }

      return {
        targetDir: path.dirname(moduleBundleFilepath),
        requestOpts: getRequestOpts(args, {
          isContainerModule,
          entryFile: moduleInputFilepath,
          sourceUrl: moduleBundleUrl,
          sourceMapUrl: moduleSourceMapUrl,
        }),
        saveBundleOpts: getSaveBundleOpts(args, {
          bundleOutput: moduleBundleFilepath,
          sourcemapOutput: moduleSourceMapFilepath,
        }),
      };
    },
  );
}
