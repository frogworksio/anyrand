import { getBytes, hexlify } from 'ethers'

export const DRAND_BN254_INFO = {
    public_key:
        '132129f8c30a43d4c00d2d6b1f6cabd3184be62f829846301c805ba8eb8570d81c80c7ab94dbf2fb22ebee71ab2b6f79d27d445d3d6ddc2ef1d28df86955c0eb1aad8f4a986b9a4157543ef2145bbf773863dc5acbfec48a5ff8078d6efecf9e00c74538d9f890a2c177633c7f88a4cb27dc4407decc55a770b5ecbcda759010',
    period: 3,
    genesis_time: 1707657321,
    hash: 'ee170bf15d789de7c3264dcea5b214e2745f20833a0b276bdc8db73522342e8e',
    groupHash: '016c244897664763288dc1afde9d9bef453c99026fa6314110c12e1452e96002',
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
