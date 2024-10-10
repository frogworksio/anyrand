import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('GasStationScroll', (m) => {
    const gasStationScroll = m.contract('GasStationScroll', [])
    return {
        gasStationScroll,
    }
})
