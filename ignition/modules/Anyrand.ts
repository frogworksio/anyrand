import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('Anyrand', (m) => {
    const factoryInitData = m.getParameter('factoryInitData', '0x')
    const impl = m.contract('Anyrand', [])
    const proxy = m.contract('ERC1967Proxy', [impl, factoryInitData])
    return {
        proxy,
        impl,
    }
})
