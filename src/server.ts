/**
 * Server bootstrap — wires HederaMCPToolkit with our plugin + fee-calculator
 * loader + account resolver. Called from both transports/stdio.ts and
 * transports/http.ts.
 *
 * See docs/DESIGN.md §6, §7, §8.
 */

import { buildAccountRegistry } from './accounts.js';
import { DefaultFeeCalculator } from './fees/DefaultFeeCalculator.js';
import type { FeeCalculator } from './fees/FeeCalculator.js';
import { log } from './logger.js';

// TODO: import HederaMCPToolkit from '@hashgraph/hedera-agent-kit-mcp' after first install
// TODO: import core plugins (coreAccountPlugin, coreConsensusPlugin) from '@hashgraph/hedera-agent-kit'
// TODO: import { xeniIntentMandatePlugin } from './plugins/xeniIntentMandate/index.js'

export interface ServerConfig {
  network: 'testnet' | 'mainnet';
  transport: 'stdio' | 'http';
  httpBind: string;
  httpPort: number;
  nodeEnv: 'development' | 'test' | 'production';
}

export function loadConfig(): ServerConfig {
  const nodeEnv = (process.env['NODE_ENV'] ?? 'development') as ServerConfig['nodeEnv'];
  const transport = (process.env['HEDERA_TRANSPORT'] ?? 'stdio') as ServerConfig['transport'];

  // Security rule (docs/DESIGN.md §8): HTTP transport is forbidden in production.
  if (nodeEnv === 'production' && transport === 'http') {
    log.error('HTTP transport is not permitted in production. Use stdio.');
    process.exit(1);
  }

  return {
    network: (process.env['HEDERA_NETWORK'] ?? 'testnet') as ServerConfig['network'],
    transport,
    httpBind: process.env['HEDERA_HTTP_BIND'] ?? '127.0.0.1',
    httpPort: Number(process.env['HEDERA_HTTP_PORT'] ?? '7701'),
    nodeEnv,
  };
}

/**
 * Load the fee calculator per docs/DESIGN.md §7:
 *   - dev: fail-open to DefaultFeeCalculator
 *   - test: fail-open
 *   - production: fail-closed (refuse to start if private plugin missing / fails)
 */
export async function loadFeeCalculator(config: ServerConfig): Promise<FeeCalculator> {
  const privatePluginsEnv = process.env['HEDERA_XENI_PRIVATE_PLUGINS']?.trim();
  const expectedImpl = process.env['EXPECTED_FEE_CALCULATOR_IMPL']?.trim();

  let impl: FeeCalculator;

  if (!privatePluginsEnv) {
    if (config.nodeEnv === 'production') {
      log.error('HEDERA_XENI_PRIVATE_PLUGINS required in production; refusing to start.');
      process.exit(1);
    }
    log.info('Loaded fee calculator: DefaultFeeCalculator', { reason: 'no private plugin set' });
    impl = new DefaultFeeCalculator();
  } else {
    try {
      // TODO: dynamic import of the private plugin module — something like:
      // const mod = await import(privatePluginsEnv);
      // impl = new mod.PlatformFeeCalculator();
      throw new Error('private plugin loader — scaffold skeleton; implementation lands in next PR');
    } catch (err) {
      if (config.nodeEnv === 'production') {
        log.error(`Private plugin load failed; refusing to start: ${String(err)}`);
        process.exit(1);
      }
      log.warn(`Private plugin load failed, falling back to DefaultFeeCalculator`, {
        error: String(err),
      });
      impl = new DefaultFeeCalculator();
    }
  }

  // Startup health check — assert loaded impl matches expectation if set.
  if (expectedImpl && impl.name !== expectedImpl) {
    log.error(`Fee calculator mismatch: loaded=${impl.name} expected=${expectedImpl}`);
    process.exit(1);
  }
  log.info(`Loaded fee calculator: ${impl.name}`);

  return impl;
}

/**
 * Build the HederaMCPToolkit instance. Transport-agnostic.
 */
export async function buildToolkit(_config: ServerConfig): Promise<unknown> {
  const accounts = buildAccountRegistry();
  const _feeCalculator = await loadFeeCalculator(_config);

  log.info('Account registry initialized', {
    operator: accounts.get('operator').accountId,
    agent: accounts.get('agent').accountId,
    xeni_treasury: accounts.get('xeni_treasury').accountId,
  });

  // TODO: construct two Clients (operator, agent) from @hiero-ledger/sdk
  // TODO: construct HederaMCPToolkit({
  //   plugins: [coreAccountPlugin, coreConsensusPlugin, xeniIntentMandatePlugin],
  //   clientResolver: (tool) => resolveRole({ tool }, accounts) === 'operator' ? operatorClient : agentClient,
  //   feeCalculator,
  // })
  // TODO: return the toolkit
  throw new Error('buildToolkit: scaffold skeleton; implementation lands in next PR');
}
