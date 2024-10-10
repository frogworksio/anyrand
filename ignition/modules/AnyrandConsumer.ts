import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('AnyrandConsumer', (m) => {
    const anyrand = m.getParameter('anyrand', '0x')
    const anyrandConsumer = m.contract('AnyrandConsumer', [anyrand])
    return {
        anyrandConsumer,
    }
})
