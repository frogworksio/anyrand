import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('DrandBeacon', (m) => {
    const publicKey = m.getParameter('publicKey')
    const genesisTimestamp = m.getParameter('genesisTimestamp')
    const period = m.getParameter('period')

    const drandBeacon = m.contract('DrandBeacon', [publicKey, genesisTimestamp, period])

    return {
        drandBeacon,
    }
})
