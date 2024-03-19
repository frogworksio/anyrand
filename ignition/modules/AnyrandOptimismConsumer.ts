import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'
import AnyrandOptimismModule from './AnyrandOptimism'

const AnyrandOptimismConsumer = buildModule('AnyrandOptimismConsumer', (m) => {
    const { anyrand } = m.useModule(AnyrandOptimismModule)

    const anyrandConsumer = m.contract('AnyrandConsumer', [anyrand])

    return {
        anyrandConsumer,
    }
})

export default AnyrandOptimismConsumer
