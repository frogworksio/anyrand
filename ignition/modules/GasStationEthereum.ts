import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('GasStationEthereum', (m) => {
    const gasStationEthereum = m.contract('GasStationEthereum', [])
    return {
        gasStationEthereum,
    }
})
