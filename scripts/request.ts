import { ethers } from 'hardhat'
import { Anyrand__factory, AnyrandConsumer__factory } from '../typechain-types'
import assert from 'node:assert'
import { formatUnits } from 'ethers'

const ANYRAND_CONSUMER_ADDRESS = '0x2ADe7e2158C07E00b4F0e1b577743a17B8F0f4C9'

async function main() {
    const [deployer] = await ethers.getSigners()
    let nonce = await deployer.getNonce()

    const consumer = await AnyrandConsumer__factory.connect(
        ANYRAND_CONSUMER_ADDRESS,
        deployer,
    ).waitForDeployment()
    const anyrand = await Anyrand__factory.connect(
        await consumer.anyrand(),
        deployer,
    ).waitForDeployment()
    const callbackGasLimit = 50_000

    const { maxFeePerGas: _maxFeePerGas, maxPriorityFeePerGas: _maxPriorityFeePerGas } =
        await ethers.provider.getFeeData()
    assert(_maxFeePerGas)
    const maxFeePerGas = (_maxFeePerGas! * 15000n) / 10000n
    const maxPriorityFeePerGas = (_maxPriorityFeePerGas! * 15000n) / 10000n
    console.log(`Max fee per gas: ${formatUnits(maxFeePerGas, 'gwei')} gwei`)

    const [requestPrice] = await anyrand.getRequestPrice(callbackGasLimit, {
        gasPrice: maxFeePerGas,
        blockTag: 'pending',
    })

    const deadline = Math.floor(Date.now() / 1000) + 120

    // Fire off 10 random requests
    for (let i = 0; i < 10; i++) {
        // Fast gas: 150% of estimate

        // Anywhere from 1-4 minutes
        // const randomMinutes = 60 + Math.floor(Math.random() * 3 * 60)
        const tx = await consumer.getRandom(deadline - 5 * i, callbackGasLimit, {
            value: requestPrice * 2n, // excess will be refunded
            nonce: nonce++,
            maxFeePerGas,
            maxPriorityFeePerGas,
        })
        console.log(`Broadcasted tx: ${tx.hash}`)
    }
}

main()
    .then(() => {
        console.log('Done')
    })
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })
