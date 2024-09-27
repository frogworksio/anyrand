import { bn254 } from '@kevincharm/noble-bn254-drand'
import {
    Anyrand,
    Anyrand__factory,
    DrandBeacon,
    DrandBeacon__factory,
    ERC1967Proxy__factory,
    GasStationEthereum__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { parseEther } from 'ethers'

interface AnyrandStackConfig {
    deployer: SignerWithAddress
    beacon?:
        | `0x${string}`
        | {
              pubKey: string
              genesisTimestamp: bigint
              period: bigint
          }
    baseRequestPrice?: bigint
    maxCallbackGasLimit?: bigint
    maxDeadlineDelta?: bigint
    gasStation?: `0x${string}`
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
        config.baseRequestPrice || parseEther('0.001'),
        config.maxCallbackGasLimit || 2_000_000,
        config.maxDeadlineDelta || 1800,
        await gasStation.getAddress(),
    ]
    const anyrandImpl = await new Anyrand__factory(config.deployer).deploy()
    const anyrandProxy = await new ERC1967Proxy__factory(config.deployer).deploy(
        await anyrandImpl.getAddress(),
        anyrandImpl.interface.encodeFunctionData('init', anyrandArgs as any),
    )
    const anyrand = Anyrand__factory.connect(await anyrandProxy.getAddress(), config.deployer)
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
    const round = delta / period + (delta % period)
    return round
}
