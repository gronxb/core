import type { ConfigT } from 'metro-config';
import type { ModuleFederationConfigNormalized } from './types';
import type { FederatedTypesMeta } from './utils/federated-remote-types';

export const FEDERATION_BUILD_SESSION = Symbol.for(
  '@module-federation/metro/FederationBuildSession',
);

/**
 * Mutable state owned by one loaded Metro configuration.
 *
 * `originalEntryPath` is rebound by the host bundle command after config
 * loading. `dtsAssets` is populated asynchronously by the development server.
 */
export type FederationBuildSession = {
  readonly federationConfig: ModuleFederationConfigNormalized;
  readonly hostEntryPath: string;
  readonly remoteEntryPath: string;
  readonly manifestPath: string;
  readonly tmpDirPath: string;
  originalEntryPath: string;
  dtsAssets?: FederatedTypesMeta;
};

type ConfigWithFederationBuildSession = ConfigT & {
  [FEDERATION_BUILD_SESSION]: FederationBuildSession;
};

function hasFederationBuildSession(
  config: ConfigT,
): config is ConfigWithFederationBuildSession {
  return Object.prototype.hasOwnProperty.call(config, FEDERATION_BUILD_SESSION);
}

export function getFederationBuildSession(
  config: ConfigT,
): FederationBuildSession | undefined {
  return hasFederationBuildSession(config)
    ? config[FEDERATION_BUILD_SESSION]
    : undefined;
}
