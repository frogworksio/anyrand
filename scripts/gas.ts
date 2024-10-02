import { Transaction, formatEther, formatUnits, getBytes } from 'ethers'
import { ethers } from 'hardhat'
import { IL1GasPriceOracle__factory } from '../typechain-types'

async function main() {
    const [deployer] = await ethers.getSigners()
    if ((await ethers.provider.getNetwork().then((network) => network.chainId)) !== 534351n) {
        throw new Error('Expected Scroll Sepolia')
    }
    const tx = await deployer.provider.getTransaction(
        '0x449a8ec4053adcb3c32fa06b03269b08439a19e74fd5b9ce35d26667d07d03bc',
    )
    const raw = Transaction.from(tx!).unsignedSerialized
    console.log(`Raw:\t\t${raw}`)
    console.log(`Calldata:\t${tx!.data}`)

    const indexOfCalldata = raw.indexOf(tx!.data.slice(2))
    const highlighted =
        raw.slice(0, indexOfCalldata) +
        '\x1B[32m' +
        tx!.data.slice(2) +
        '\x1B[0m' +
        raw.slice(indexOfCalldata + tx!.data.length)
    console.log(`Highlighted:\t${highlighted}`)

    console.log(`RLP:\t\t${ethers.decodeRlp(getBytes(raw).slice(1))}`) // eip-1559 is a typed tx envelope, first byte is out of bounds

    const txBytes = getBytes(raw)
    const zeros = BigInt(txBytes.filter((v) => v === 0).byteLength)
    const nonzeros = BigInt(txBytes.byteLength) - zeros
    console.log(`Zero bytes:\t${zeros}`)
    console.log(`Nonzero bytes:\t${nonzeros}`)

    const oracle = IL1GasPriceOracle__factory.connect(
        '0x5300000000000000000000000000000000000002',
        deployer,
    )
    const requestTx = await deployer.provider.getTransaction(
        '0x6e4424d42799bc99c5165454a4a5e190ab19ee71e45062078430ef823fd7aa87',
    )
    const l1Fee = await oracle.getL1Fee(raw, {
        blockTag: requestTx!.blockNumber!,
    })
    console.log(`L1 fee:\t\t${formatEther(l1Fee)} ETH`)

    console.log(`Request gasPrice:\t${formatUnits(requestTx!.gasPrice, 'gwei')} gwei`)
    const l2Fee = (215_000n + 50_000n) * requestTx!.gasPrice
    console.log(`L2 fee:\t\t${formatEther(l2Fee)} ETH`)
    console.log(`Total:\t\t${formatEther(((l1Fee + l2Fee) * 15000n) / 10000n)} ETH`)
}

main()
    .then(() => {
        console.log('Done')
    })
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })
