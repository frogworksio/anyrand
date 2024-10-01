import { ethers, ignition, run } from 'hardhat'
import { parseUnits } from 'ethers'
import { getDrandBeaconInfo } from '../lib/drand'
import { bn254 } from '@kevincharm/noble-bn254-drand'
import { Anyrand__factory } from '../typechain-types'
import Anyrand from '../ignition/modules/Anyrand'
import DrandBeacon from '../ignition/modules/DrandBeacon'
import GasStationScroll from '../ignition/modules/GasStationScroll'
import AnyrandConsumer from '../ignition/modules/AnyrandConsumer'
const REQUEST_PREMIUM_BPS = 5000n // 50%
const MAX_CALLBACK_GAS_LIMIT = 2_500_000n
const MAX_DEADLINE_DELTA = 5n * 60n // 5 minutes
const MAX_FEE_PER_GAS = parseUnits('10', 'gwei')

const DEPLOYMENT_VERSION = '0_0_0-test'

async function getDeploymentId() {
    const chainId = await ethers.provider.getNetwork().then((network) => network.chainId)
    return `chain-${chainId.toString()}-v${DEPLOYMENT_VERSION}`
}

async function main() {
    const chainId = await ethers.provider.getNetwork().then((network) => network.chainId)
    if (chainId !== 534351n && chainId !== 534352n) {
        throw new Error(`Unexpected chainid: ${chainId}`)
    }

    const deploymentId = await getDeploymentId()
    console.log(`Deployment ID: ${deploymentId}`)

    // Beacon
    const evmnet = await getDrandBeaconInfo('evmnet')
    const publicKey = bn254.G2.ProjectivePoint.fromHex(evmnet.public_key).toAffine()
    const { drandBeacon } = await ignition.deploy(DrandBeacon, {
        deploymentId,
        parameters: {
            DrandBeacon: {
                publicKey: [publicKey.x.c0, publicKey.x.c1, publicKey.y.c0, publicKey.y.c1],
                genesisTimestamp: evmnet.genesis_time,
                period: evmnet.period,
            },
        },
    })

    // Gas station
    const { gasStationScroll } = await ignition.deploy(GasStationScroll, {
        deploymentId,
    })

    // Anyrand coordinator
    const factoryInitData = Anyrand__factory.createInterface().encodeFunctionData('init', [
        await drandBeacon.getAddress(),
        REQUEST_PREMIUM_BPS,
        MAX_CALLBACK_GAS_LIMIT,
        MAX_DEADLINE_DELTA,
        await gasStationScroll.getAddress(),
        MAX_FEE_PER_GAS,
    ])
    const { proxy } = await ignition.deploy(Anyrand, {
        deploymentId,
        parameters: {
            Anyrand: {
                factoryInitData,
            },
        },
    })
    console.log(`Anyrand upgradeable proxy deployed at ${await proxy.getAddress()}`)

    const { anyrandConsumer } = await ignition.deploy(AnyrandConsumer, {
        deploymentId,
        parameters: {
            AnyrandConsumer: {
                anyrand: await proxy.getAddress(),
            },
        },
    })
    console.log(`Anyrand consumer deployed at ${await anyrandConsumer.getAddress()}`)

    // Verify all
    await run(
        {
            scope: 'ignition',
            task: 'verify',
        },
        {
            deploymentId,
        },
    )
}

main()
    .then(() => {
        process.exit(0)
    })
    .catch((error) => {
        console.error(error)
        process.exit(1)
    })
