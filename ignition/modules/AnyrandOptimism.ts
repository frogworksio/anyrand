import { parseEther } from 'ethers'
import { DRAND_BN254_INFO, decodeG2 } from '../../lib/drand'

import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

const REQUEST_PRICE = parseEther('0.001')
const MAX_CALLBACK_GAS_LIMIT = 2_000_000
const MAX_DEADLINE_DELTA = 1800 // 30 mins into the future

const AnyrandOptimismModule = buildModule('AnyrandOptimismModule', (m) => {
    const publicKey = m.getParameter('publicKey', decodeG2(DRAND_BN254_INFO.public_key))
    const genesisTime = m.getParameter('genesisTime', BigInt(DRAND_BN254_INFO.genesis_time))
    const period = m.getParameter('period', BigInt(DRAND_BN254_INFO.period))
    const requestPrice = m.getParameter('requestPrice', REQUEST_PRICE)
    const maxCallbackGasLimit = m.getParameter('maxCallbackGasLimit', MAX_CALLBACK_GAS_LIMIT)
    const maxDeadlineDelta = m.getParameter('maxDeadlineDelta', MAX_DEADLINE_DELTA)

    const anyrand = m.contract('AnyrandOptimism', [
        publicKey,
        genesisTime,
        period,
        requestPrice,
        maxCallbackGasLimit,
        maxDeadlineDelta,
    ])

    return {
        anyrand,
    }
})

export default AnyrandOptimismModule
