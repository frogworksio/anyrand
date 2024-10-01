import { Transaction, concat, getBytes } from 'ethers'
import { ethers } from 'hardhat'
import { TestFlz__factory } from '../typechain-types'
const abi = ethers.AbiCoder.defaultAbiCoder()

async function main() {
    const [deployer] = await ethers.getSigners()
    if ((await ethers.provider.getNetwork().then((network) => network.chainId)) !== 534351n) {
        throw new Error('Expected Scroll Sepolia')
    }
    const tx = await deployer.provider.getTransaction(
        '0xaa54e3612f97ab1be8c75896e3386a547dabb59904e3be6e3709076a88ab39a4',
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

    const TX_DATA_ZERO_GAS = 4n
    const TX_DATA_NON_ZERO_GAS = 16n
    const overhead = 2500n
    const scalar = 1150000000n

    const l1BaseFee = 244412364n
    const l1Gas = zeros * TX_DATA_ZERO_GAS + (nonzeros + 4n) * TX_DATA_NON_ZERO_GAS
    const l1GasFee = ((l1Gas + overhead) * l1BaseFee * scalar) / BigInt(1e9)
    console.log(`L1 gas fee:\t${l1GasFee}`)

    const [compressedTxBytes] = abi.decode(
        ['bytes'],
        await ethers.provider.call({
            data: concat([TestFlz__factory.bytecode, abi.encode(['bytes'], [txBytes])]),
        }),
    )
    console.log(
        `FLZ compressed ${txBytes.length} bytes to ${getBytes(compressedTxBytes).byteLength} bytes`,
    )
}

main()
    .then(() => {
        console.log('Done')
    })
    .catch((err) => {
        console.error(err)
        process.exit(1)
    })
