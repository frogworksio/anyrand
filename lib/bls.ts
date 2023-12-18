const ___mcl = require('mcl-wasm')
import { dataSlice, hexlify, keccak256, randomBytes, sha256 } from 'ethers'
import Mcl from 'mcl-wasm'
import type { G1, G2, Fr, Fp, Fp2 } from 'mcl-wasm'
const __mcl = ___mcl as typeof Mcl
export type { G1, G2, Fr, Fp, Fp2 }

export const FIELD_ORDER = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n

let _mcl: typeof Mcl
export async function getMcl() {
    if (!_mcl) {
        await __mcl.init(__mcl.BN_SNARK1)
        _mcl = __mcl
    }

    return _mcl
}

let _domain: Uint8Array
let _G1: G1
let _G2: G2
export async function getCurveParams() {
    if (_domain && _G1 && _G2) {
        return {
            domain: _domain,
            G1: _G1,
            G2: _G2,
        }
    }

    const mcl = await getMcl()
    _domain = Uint8Array.from(Buffer.from('blablabla', 'utf-8'))
    _G1 = new mcl.G1()
    const g1x: Fp = new mcl.Fp()
    const g1y: Fp = new mcl.Fp()
    const g1z: Fp = new mcl.Fp()
    g1x.setStr('01', 16)
    g1y.setStr('02', 16)
    g1z.setInt(1)
    _G1.setX(g1x)
    _G1.setY(g1y)
    _G1.setZ(g1z)
    _G2 = new mcl.G2()
    const g2x = await createFp2(
        '0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed',
        '0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2',
    )
    const g2y = await createFp2(
        '0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa',
        '0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b',
    )
    const g2z = await createFp2('0x01', '0x00')
    _G2.setX(g2x)
    _G2.setY(g2y)
    _G2.setZ(g2z)

    return {
        domain: _domain,
        G1: _G1,
        G2: _G2,
    }
}

async function createFp2(a: string, b: string) {
    const mcl = await getMcl()
    const fp2_a: Fp = new mcl.Fp()
    const fp2_b: Fp = new mcl.Fp()
    fp2_a.setStr(a)
    fp2_b.setStr(b)
    const fp2: Fp2 = new mcl.Fp2()
    fp2.set_a(fp2_a)
    fp2.set_b(fp2_b)
    return fp2
}

export async function createKeyPair(sk?: `0x${string}`) {
    const mcl = await getMcl()
    const secretKey = new mcl.Fr()
    if (sk) {
        secretKey.setHashOf(sk)
    } else {
        secretKey.setHashOf(hexlify(randomBytes(12)))
    }
    const { G2 } = await getCurveParams()
    const pubKey = mcl.mul(G2, secretKey)
    pubKey.normalize()
    return {
        secretKey,
        pubKey,
    }
}

export async function sign(M: G1, sk: Fr) {
    const mcl = await getMcl()
    const signature: G1 = mcl.mul(M, sk)
    signature.normalize()
    return {
        signature,
        M,
    }
}

export function serialiseFp(p: Fp | Fp2): `0x${string}` {
    // NB: big-endian
    return ('0x' +
        Array.from(p.serialize())
            .reverse()
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')) as `0x${string}`
}

export function serialiseG1Point(p: G1): [bigint, bigint] {
    p.normalize()
    const x = BigInt(serialiseFp(p.getX()))
    const y = BigInt(serialiseFp(p.getY()))
    return [x, y]
}

export function serialiseG2Point(p: G2): [bigint, bigint, bigint, bigint] {
    const x = serialiseFp(p.getX())
    const y = serialiseFp(p.getY())
    return [
        BigInt(dataSlice(x, 32)),
        BigInt(dataSlice(x, 0, 32)),
        BigInt(dataSlice(y, 32)),
        BigInt(dataSlice(y, 0, 32)),
    ]
}

export async function createG1(x: bigint, y: bigint) {
    const mcl = await getMcl()
    const G1x = new mcl.Fp()
    G1x.setStr(x.toString())
    const G1y = new mcl.Fp()
    G1y.setStr(y.toString())
    const G1z = new mcl.Fp()
    G1z.setInt(1)
    const G1 = new mcl.G1()
    G1.setX(G1x)
    G1.setY(G1y)
    G1.setZ(G1z)
    return G1
}

export async function hashToPoint(msg: `0x${string}`) {
    let x = BigInt(keccak256(msg)) % FIELD_ORDER
    let y: bigint
    let found = false
    for (;;) {
        y = (x * x) % FIELD_ORDER
        y = (y * x) % FIELD_ORDER
        y = (y + 3n) % FIELD_ORDER
        ;({ result: y, hasRoot: found } = sqrt(y))
        if (found) {
            return createG1(x, y)
        }
        x = (x + 1n) % FIELD_ORDER
    }
}

function sqrt(base: bigint) {
    const exp = 0xc19139cb84c680a6e14116da060561765e05aa45a1c72a34f082305b61f3f52n
    const mod = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n
    const result: bigint = modexp(base, exp, mod)
    const hasRoot = base === (result * result) % FIELD_ORDER
    return {
        result,
        hasRoot,
    }
}

function modexp(base: bigint, exp: bigint, mod: bigint) {
    base = base % mod
    let result = 1n
    let x = base
    while (exp > 0) {
        let leastSignificantBit = exp % 2n
        exp = exp / 2n
        if (leastSignificantBit == 1n) {
            result = result * x
            result = result % mod
        }
        x = x * x
        x = x % mod
    }
    return result
}
