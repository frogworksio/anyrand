import { getBytes, hexlify } from 'ethers'

export const DRAND_BN254_INFO = {
    public_key:
        '11a5b52383dcdaf609c7d993e0eee909da873fafcc5b5727a757b70f390ba1321c698cd5ae4c6c1e0a8256853d80025e4e274e4a85466bc5966fa33c8887a7482d84ea13f327bbf97683f28a2c07048af9e0b109ac09b3adee4dbf76280cdb0c0aec4a98aae82e083c467a2cbb33ec23b49d01875fbf4b126395e4d7fec7a64a',
    period: 1,
    genesis_time: 1710884219,
    hash: 'ce2b88ba52087c5f4c3fd22e92ba78d1389295ac975d2bb95614a11efc532fa0',
    groupHash: '70f37215b462863cea451f14da30c050f01e30b989ffd7e223c777078127481d',
    schemeID: 'bls-bn254-unchained-on-g1',
    metadata: { beaconID: 'fairy-drand-bn254-dev' },
}

export function decodeG2(point: string) {
    const pkBytes = getBytes(`0x${point}`)
    const publicKey = [
        pkBytes.slice(32, 64),
        pkBytes.slice(0, 32),
        pkBytes.slice(96, 128),
        pkBytes.slice(64, 96),
    ].map((pkBuf) => BigInt(hexlify(pkBuf))) as [bigint, bigint, bigint, bigint]
    return publicKey
}

export function decodeG1(point: string) {
    const sigBytes = getBytes(`0x${point}`)
    const sig = [sigBytes.slice(0, 32), sigBytes.slice(32, 64)].map((sigBuf) =>
        BigInt(hexlify(sigBuf)),
    ) as [bigint, bigint]
    return sig
}
