import { describe, expect, it } from '@rstest/core';
import bundleFederatedHost from '../../src/commands/bundle-host';
import bundleFederatedRemote from '../../src/commands/bundle-remote';

describe('federated bundle command contract', () => {
  it('keeps the host CLI facade at three arguments and exposes loaded-config execution', () => {
    expect(bundleFederatedHost).toHaveLength(3);
    expect(bundleFederatedHost.executeWithConfig).toBeTypeOf('function');
  });

  it('keeps the remote CLI facade at three arguments and exposes loaded-config execution', () => {
    expect(bundleFederatedRemote).toHaveLength(3);
    expect(bundleFederatedRemote.executeWithConfig).toBeTypeOf('function');
  });
});
