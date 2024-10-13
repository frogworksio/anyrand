import { bn254 } from '@kevincharm/noble-bn254-drand'
import {
    Anyrand,
    AnyrandHarness__factory,
    DrandBeacon,
    DrandBeacon__factory,
    ERC1967Proxy__factory,
    GasStationEthereum__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { getBytes, keccak256, parseEther, parseUnits } from 'ethers'

export type G1 = typeof bn254.G1.ProjectivePoint.BASE
export type G2 = typeof bn254.G2.ProjectivePoint.BASE
export const DRAND_EVMNET_DST = 'BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_'

export interface AnyrandStackConfig {
    deployer: SignerWithAddress
    beacon?:
        | `0x${string}`
        | {
              pubKey: string
              genesisTimestamp: bigint
              period: bigint
          }
    requestPremiumBps?: bigint
    maxCallbackGasLimit?: bigint
    maxDeadlineDelta?: bigint
    gasStation?: `0x${string}`
    maxFeePerGas?: bigint
}

export async function deployAnyrandStack(config: AnyrandStackConfig) {
    let drandBeacon: DrandBeacon
    if (typeof config.beacon === 'undefined') {
        const beaconSecretKey = bn254.utils.randomPrivateKey()
        const beaconPubKey = bn254.G2.ProjectivePoint.fromPrivateKey(beaconSecretKey).toAffine()
        drandBeacon = await new DrandBeacon__factory(config.deployer).deploy(
            [beaconPubKey.x.c0, beaconPubKey.x.c1, beaconPubKey.y.c0, beaconPubKey.y.c1],
            Math.floor(Date.now() / 1000),
            3,
        )
    } else if (typeof config.beacon === 'string') {
        drandBeacon = DrandBeacon__factory.connect(config.beacon, config.deployer)
    } else {
        const beaconPubKey = bn254.G2.ProjectivePoint.fromHex(config.beacon.pubKey)
        drandBeacon = await new DrandBeacon__factory(config.deployer).deploy(
            [beaconPubKey.x.c0, beaconPubKey.x.c1, beaconPubKey.y.c0, beaconPubKey.y.c1],
            config.beacon.genesisTimestamp,
            config.beacon.period,
        )
    }

    const gasStation = config.gasStation
        ? GasStationEthereum__factory.connect(config.gasStation, config.deployer)
        : await new GasStationEthereum__factory(config.deployer).deploy()

    const anyrandArgs: Parameters<Anyrand['init']> = [
        await drandBeacon.getAddress(),
        config.requestPremiumBps || 20_00,
        config.maxCallbackGasLimit || 2_000_000,
        config.maxDeadlineDelta || 1800,
        await gasStation.getAddress(),
        config.maxFeePerGas || parseUnits('5', 'gwei'),
    ]
    const anyrandImpl = await new AnyrandHarness__factory(config.deployer).deploy()
    const anyrandProxy = await new ERC1967Proxy__factory(config.deployer).deploy(
        await anyrandImpl.getAddress(),
        anyrandImpl.interface.encodeFunctionData('init', anyrandArgs as any),
    )
    const anyrand = AnyrandHarness__factory.connect(
        await anyrandProxy.getAddress(),
        config.deployer,
    )

    return {
        anyrand,
        anyrandImpl,
        anyrandArgs,
        drandBeacon,
        gasStation,
    }
}

export function getRound(genesis: bigint, deadline: bigint, period: bigint) {
    const delta = deadline - genesis
    const round = delta / period + (delta % period > 0n ? 1n : 0n)
    return round
}

export function getHashedRoundMsg(round: bigint, DST?: string | Uint8Array) {
    const roundBytes = getBytes('0x' + round.toString(16).padStart(16, '0'))
    const M = bn254.G1.hashToCurve(getBytes(keccak256(roundBytes) as `0x${string}`), {
        DST: DST || DRAND_EVMNET_DST,
    }) as G1
    return M
}
