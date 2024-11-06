import { ethers, ignition, run } from 'hardhat'
import { getAddress, parseUnits } from 'ethers'
import { getDrandBeaconInfo } from '../lib/drand'
import { bn254 } from '@kevincharm/noble-bn254-drand'
import { Anyrand__factory } from '../typechain-types'
import Anyrand from '../ignition/modules/Anyrand'
import DrandBeacon from '../ignition/modules/DrandBeacon'
import GasStationOptimism from '../ignition/modules/GasStationOptimism'
import AnyrandConsumer from '../ignition/modules/AnyrandConsumer'
import assert from 'node:assert'

const REQUEST_PREMIUM_MULTIPLIER_BPS = 150_00n // 150% => 1.5x multiplier (=> 50% premium on top)
const MAX_CALLBACK_GAS_LIMIT = 7_500_000n
const MAX_DEADLINE_DELTA = 5n * 60n // 5 minutes
const MAX_FEE_PER_GAS = parseUnits('30', 'gwei') // gas lane

// (mainnet): Address of the Anyrand admin multisig
const ANYRAND_ADMIN_MULTISIG = getAddress('0x08565a9F2F82d632b3EaE6DEc0b8b87127a6f1A4')

const DEPLOYMENT_VERSION = '1_0_0'

async function getDeploymentId() {
    const chainId = await ethers.provider.getNetwork().then((network) => network.chainId)
    return `chain-${chainId.toString()}-v${DEPLOYMENT_VERSION}`
}

async function main() {
    const chainId = await ethers.provider.getNetwork().then((network) => network.chainId)
    if (chainId !== 8453n && chainId !== 84532n) {
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
    const { gasStationOptimism } = await ignition.deploy(GasStationOptimism, {
        deploymentId,
    })

    // Anyrand coordinator
    const factoryInitData = Anyrand__factory.createInterface().encodeFunctionData('init', [
        await drandBeacon.getAddress(),
        REQUEST_PREMIUM_MULTIPLIER_BPS,
        MAX_CALLBACK_GAS_LIMIT,
        MAX_DEADLINE_DELTA,
        await gasStationOptimism.getAddress(),
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

    // Transfer ownership to multisig
    const [deployer] = await ethers.getSigners()
    const anyrand = Anyrand__factory.connect(await proxy.getAddress(), deployer)
    await anyrand.transferOwnership(ANYRAND_ADMIN_MULTISIG).then((tx) => tx.wait(1))
    console.log(`Anyrand ownership transferred to ${ANYRAND_ADMIN_MULTISIG}`)

    // Sanity checks!
    assert(
        getAddress(await anyrand.owner()) === ANYRAND_ADMIN_MULTISIG,
        'Anyrand owner is not multisig',
    )
    assert(
        (await anyrand.nextRequestId()) === 1n,
        'Proxy not initialised properly? nextRequestId != 1',
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
