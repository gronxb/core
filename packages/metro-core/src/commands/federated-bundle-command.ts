import type { ConfigT } from 'metro-config';
import type { Config } from './types';

export type FederatedBundleContext<Args> = {
  readonly cfg: Config;
  readonly args: Args;
  readonly metroConfig: ConfigT;
};

export type FederatedBundleCommand<Args> = {
  (_argv: Array<string>, cfg: Config, args: Args): Promise<void>;
  readonly executeWithConfig: (
    context: FederatedBundleContext<Args>,
  ) => Promise<void>;
};
