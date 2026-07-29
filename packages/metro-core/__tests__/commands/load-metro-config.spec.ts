import path from 'node:path';
import { beforeEach, describe, expect, it, rs } from '@rstest/core';
import type { ConfigT } from 'metro-config';
import type { Config } from '../../src/commands/types';

const { mockLoadConfig, mockMergeConfig, mockResolveConfig } = rs.hoisted(
  () => ({
    mockLoadConfig: rs.fn(),
    mockMergeConfig: rs.fn(),
    mockResolveConfig: rs.fn(),
  }),
);

rs.mock('metro-config', () => ({
  loadConfig: mockLoadConfig,
  mergeConfig: mockMergeConfig,
  resolveConfig: mockResolveConfig,
}));

import loadMetroConfig from '../../src/commands/utils/load-metro-config';

describe('loadMetroConfig', () => {
  const metroConfig = {
    projectRoot: '/project',
    resolver: {},
    serializer: {},
  } satisfies Partial<ConfigT>;

  const createCommandConfig = (): Config => ({
    root: '/project',
    platforms: { ios: {} },
    reactNativePath: path.dirname(require.resolve('react-native/package.json')),
  });

  beforeEach(() => {
    rs.clearAllMocks();
    mockResolveConfig.mockResolvedValue({ isEmpty: false });
    mockMergeConfig.mockImplementation((config: ConfigT) => config);
    mockLoadConfig.mockResolvedValue(metroConfig);
  });

  it('reevaluates sequential function configs for the same command options', async () => {
    const commandConfig = createCommandConfig();
    const options = {
      config: 'metro.config.js',
      maxWorkers: 4,
      resetCache: false,
    };
    const firstMetroConfig = {
      ...metroConfig,
      projectRoot: '/project/first',
    };
    const secondMetroConfig = {
      ...metroConfig,
      projectRoot: '/project/second',
    };
    mockLoadConfig
      .mockResolvedValueOnce(firstMetroConfig)
      .mockResolvedValueOnce(secondMetroConfig);

    const firstConfig = await loadMetroConfig(commandConfig, options);
    const secondConfig = await loadMetroConfig(commandConfig, options);

    expect(firstConfig).toBe(firstMetroConfig);
    expect(secondConfig).toBe(secondMetroConfig);
    expect(mockLoadConfig).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent config evaluations invocation-local', async () => {
    const commandConfig = createCommandConfig();
    const options = { config: 'metro.config.js' };
    const firstMetroConfig = {
      ...metroConfig,
      projectRoot: '/project/concurrent-first',
    };
    const secondMetroConfig = {
      ...metroConfig,
      projectRoot: '/project/concurrent-second',
    };
    mockLoadConfig
      .mockResolvedValueOnce(firstMetroConfig)
      .mockResolvedValueOnce(secondMetroConfig);

    const [firstConfig, secondConfig] = await Promise.all([
      loadMetroConfig(commandConfig, options),
      loadMetroConfig(commandConfig, options),
    ]);

    expect(firstConfig).toBe(firstMetroConfig);
    expect(secondConfig).toBe(secondMetroConfig);
    expect(mockLoadConfig).toHaveBeenCalledTimes(2);
  });

  it('loads separate configs when CLI options differ', async () => {
    const commandConfig = createCommandConfig();

    await loadMetroConfig(commandConfig, { maxWorkers: 2 });
    await loadMetroConfig(commandConfig, { maxWorkers: 4 });

    expect(mockLoadConfig).toHaveBeenCalledTimes(2);
  });

  it('allows the next config load after a load rejects', async () => {
    const commandConfig = createCommandConfig();
    mockLoadConfig.mockRejectedValueOnce(new Error('load failed'));

    await expect(loadMetroConfig(commandConfig)).rejects.toThrow('load failed');
    await expect(loadMetroConfig(commandConfig)).resolves.toBe(metroConfig);

    expect(mockLoadConfig).toHaveBeenCalledTimes(2);
  });
});
