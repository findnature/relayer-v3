import { typeguards } from "@across-protocol/sdk-v2";
import { BigNumber, toBNWei, assert, isDefined, readFileSync, toBN, replaceAddressCase, ethers } from "../utils";
import { CommonConfig, ProcessEnv } from "../common";
import * as Constants from "../common/Constants";
import { InventoryConfig } from "../interfaces";

export class RelayerConfig extends CommonConfig {
  readonly externalIndexer: boolean;
  readonly indexerPath: string;
  readonly inventoryConfig: InventoryConfig;
  readonly debugProfitability: boolean;
  // Whether token price fetch failures will be ignored when computing relay profitability.
  // If this is false, the relayer will throw an error when fetching prices fails.
  readonly skipRelays: boolean;
  readonly skipRebalancing: boolean;
  readonly sendingRelaysEnabled: boolean;
  readonly sendingRebalancesEnabled: boolean;
  readonly sendingMessageRelaysEnabled: boolean;
  readonly sendingSlowRelaysEnabled: boolean;
  readonly relayerTokens: string[];
  readonly relayerOriginChains: number[] = [];
  readonly relayerDestinationChains: number[] = [];
  readonly relayerGasPadding: BigNumber;
  readonly relayerGasMultiplier: BigNumber;
  readonly relayerMessageGasMultiplier: BigNumber;
  readonly minRelayerFeePct: BigNumber;
  readonly acceptInvalidFills: boolean;
  // List of depositors we only want to send slow fills for.
  readonly slowDepositors: string[];
  // Following distances in blocks to guarantee finality on each chain.
  readonly minDepositConfirmations: {
    [threshold: number]: { [chainId: number]: number };
  };
  // Set to false to skip querying max deposit limit from /limits Vercel API endpoint. Otherwise relayer will not
  // fill any deposit over the limit which is based on liquidReserves in the HubPool.
  readonly ignoreLimits: boolean;

  constructor(env: ProcessEnv) {
    const {
      RELAYER_ORIGIN_CHAINS,
      RELAYER_DESTINATION_CHAINS,
      SLOW_DEPOSITORS,
      DEBUG_PROFITABILITY,
      RELAYER_GAS_MESSAGE_MULTIPLIER,
      RELAYER_GAS_MULTIPLIER,
      RELAYER_GAS_PADDING,
      RELAYER_EXTERNAL_INVENTORY_CONFIG,
      RELAYER_INVENTORY_CONFIG,
      RELAYER_TOKENS,
      SEND_RELAYS,
      SEND_REBALANCES,
      SEND_MESSAGE_RELAYS,
      SKIP_RELAYS,
      SKIP_REBALANCING,
      SEND_SLOW_RELAYS,
      MIN_RELAYER_FEE_PCT,
      ACCEPT_INVALID_FILLS,
      MIN_DEPOSIT_CONFIRMATIONS,
      RELAYER_IGNORE_LIMITS,
      RELAYER_EXTERNAL_INDEXER,
      RELAYER_SPOKEPOOL_INDEXER_PATH,
    } = env;
    super(env);

    // External indexing is dependent on looping mode being configured.
    this.externalIndexer = this.pollingDelay > 0 && RELAYER_EXTERNAL_INDEXER === "true";
    this.indexerPath = RELAYER_SPOKEPOOL_INDEXER_PATH ?? Constants.RELAYER_DEFAULT_SPOKEPOOL_INDEXER;

    // Empty means all chains.
    this.relayerOriginChains = JSON.parse(RELAYER_ORIGIN_CHAINS ?? "[]");
    this.relayerDestinationChains = JSON.parse(RELAYER_DESTINATION_CHAINS ?? "[]");

    // Empty means all tokens.
    this.relayerTokens = RELAYER_TOKENS
      ? JSON.parse(RELAYER_TOKENS).map((token) => ethers.utils.getAddress(token))
      : [];
    this.slowDepositors = SLOW_DEPOSITORS
      ? JSON.parse(SLOW_DEPOSITORS).map((depositor) => ethers.utils.getAddress(depositor))
      : [];

    this.minRelayerFeePct = toBNWei(MIN_RELAYER_FEE_PCT || Constants.RELAYER_MIN_FEE_PCT);

    assert(
      !isDefined(RELAYER_EXTERNAL_INVENTORY_CONFIG) || !isDefined(RELAYER_INVENTORY_CONFIG),
      "Concurrent inventory management configurations detected."
    );
    try {
      this.inventoryConfig = isDefined(RELAYER_EXTERNAL_INVENTORY_CONFIG)
        ? JSON.parse(readFileSync(RELAYER_EXTERNAL_INVENTORY_CONFIG))
        : JSON.parse(RELAYER_INVENTORY_CONFIG ?? "{}");
    } catch (err) {
      const msg = typeguards.isError(err) ? err.message : (err as Record<string, unknown>)?.code;
      throw new Error(`Inventory config error (${msg ?? "unknown error"})`);
    }

    if (Object.keys(this.inventoryConfig).length > 0) {
      this.inventoryConfig = replaceAddressCase(this.inventoryConfig); // Cast any non-address case addresses.
      this.inventoryConfig.wrapEtherThreshold = this.inventoryConfig.wrapEtherThreshold
        ? toBNWei(this.inventoryConfig.wrapEtherThreshold)
        : toBNWei(1); // default to keeping 2 Eth on the target chains and wrapping the rest to WETH.
      this.inventoryConfig.wrapEtherThresholdPerChain ??= {};
      this.inventoryConfig.wrapEtherTarget = this.inventoryConfig.wrapEtherTarget
        ? toBNWei(this.inventoryConfig.wrapEtherTarget)
        : this.inventoryConfig.wrapEtherThreshold; // default to wrapping ETH to threshold, same as target.
      this.inventoryConfig.wrapEtherTargetPerChain ??= {};
      assert(
        this.inventoryConfig.wrapEtherThreshold.gte(this.inventoryConfig.wrapEtherTarget),
        `default wrapEtherThreshold ${this.inventoryConfig.wrapEtherThreshold} must be >= default wrapEtherTarget ${this.inventoryConfig.wrapEtherTarget}`
      );

      // Validate the per chain target and thresholds for wrapping ETH:
      Object.keys(this.inventoryConfig.wrapEtherThresholdPerChain).forEach((chainId) => {
        if (this.inventoryConfig.wrapEtherThresholdPerChain[chainId] !== undefined) {
          this.inventoryConfig.wrapEtherThresholdPerChain[chainId] = toBNWei(
            this.inventoryConfig.wrapEtherThresholdPerChain[chainId]
          );
        }
      });
      Object.keys(this.inventoryConfig.wrapEtherTargetPerChain).forEach((chainId) => {
        if (this.inventoryConfig.wrapEtherTargetPerChain[chainId] !== undefined) {
          this.inventoryConfig.wrapEtherTargetPerChain[chainId] = toBNWei(
            this.inventoryConfig.wrapEtherTargetPerChain[chainId]
          );
          // Check newly set target against threshold
          const threshold =
            this.inventoryConfig.wrapEtherThresholdPerChain[chainId] ?? this.inventoryConfig.wrapEtherThreshold;
          const target = this.inventoryConfig.wrapEtherTargetPerChain[chainId];
          assert(
            threshold.gte(target),
            `wrapEtherThresholdPerChain ${threshold.toString()} must be >= wrapEtherTargetPerChain ${target}`
          );
        }
      });
      Object.keys(this.inventoryConfig?.tokenConfig ?? {}).forEach((l1Token) => {
        Object.keys(this.inventoryConfig.tokenConfig[l1Token]).forEach((chainId) => {
          const { targetPct, thresholdPct, unwrapWethThreshold, unwrapWethTarget, targetOverageBuffer } =
            this.inventoryConfig.tokenConfig[l1Token][chainId];
          assert(
            targetPct !== undefined && thresholdPct !== undefined,
            `Bad config. Must specify targetPct, thresholdPct for ${l1Token} on ${chainId}`
          );
          assert(
            toBN(thresholdPct).lte(toBN(targetPct)),
            `Bad config. thresholdPct<=targetPct for ${l1Token} on ${chainId}`
          );
          this.inventoryConfig.tokenConfig[l1Token][chainId].targetPct = toBNWei(targetPct).div(100);
          this.inventoryConfig.tokenConfig[l1Token][chainId].thresholdPct = toBNWei(thresholdPct).div(100);
          // Default to 150% the targetPct. targetOverageBuffer does not have to be defined so that no existing configs
          // are broken. This is a reasonable default because it allows the relayer to be a bit more flexible in
          // holding more tokens than the targetPct, but perhaps a better default is 100%
          this.inventoryConfig.tokenConfig[l1Token][chainId].targetOverageBuffer = toBNWei(
            targetOverageBuffer ?? "1.5"
          );
          if (unwrapWethThreshold !== undefined) {
            this.inventoryConfig.tokenConfig[l1Token][chainId].unwrapWethThreshold = toBNWei(unwrapWethThreshold);
          }
          this.inventoryConfig.tokenConfig[l1Token][chainId].unwrapWethTarget = unwrapWethTarget
            ? toBNWei(unwrapWethTarget)
            : toBNWei(2);
        });
      });
    }

    this.debugProfitability = DEBUG_PROFITABILITY === "true";
    this.relayerGasPadding = toBNWei(RELAYER_GAS_PADDING || Constants.DEFAULT_RELAYER_GAS_PADDING);
    this.relayerGasMultiplier = toBNWei(RELAYER_GAS_MULTIPLIER || Constants.DEFAULT_RELAYER_GAS_MULTIPLIER);
    this.relayerMessageGasMultiplier = toBNWei(
      RELAYER_GAS_MESSAGE_MULTIPLIER || Constants.DEFAULT_RELAYER_GAS_MESSAGE_MULTIPLIER
    );
    this.sendingRelaysEnabled = SEND_RELAYS === "true";
    this.sendingRebalancesEnabled = SEND_REBALANCES === "true";
    this.sendingMessageRelaysEnabled = SEND_MESSAGE_RELAYS === "true";
    this.skipRelays = SKIP_RELAYS === "true";
    this.skipRebalancing = SKIP_REBALANCING === "true";
    this.sendingSlowRelaysEnabled = SEND_SLOW_RELAYS === "true";
    this.acceptInvalidFills = ACCEPT_INVALID_FILLS === "true";
    (this.minDepositConfirmations = MIN_DEPOSIT_CONFIRMATIONS
      ? JSON.parse(MIN_DEPOSIT_CONFIRMATIONS)
      : Constants.MIN_DEPOSIT_CONFIRMATIONS),
      Object.keys(this.minDepositConfirmations).forEach((threshold) => {
        Object.keys(this.minDepositConfirmations[threshold]).forEach((chainId) => {
          const nBlocks: number = this.minDepositConfirmations[threshold][chainId];
          assert(
            !isNaN(nBlocks) && nBlocks >= 0,
            `Chain ${chainId} minimum deposit confirmations for "${threshold}" threshold missing or invalid (${nBlocks}).`
          );
        });
      });
    // Force default thresholds in MDC config.
    this.minDepositConfirmations["default"] = Constants.DEFAULT_MIN_DEPOSIT_CONFIRMATIONS;
    this.ignoreLimits = RELAYER_IGNORE_LIMITS === "true";
  }
}
