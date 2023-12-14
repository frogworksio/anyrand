import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import {
    Lootery__factory,
    MockRandomiser,
    MockRandomiser__factory,
    ERC1967Proxy__factory,
} from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { BytesLike, ContractFactory, ContractRunner, Signer, parseEther } from 'ethers'
import { expect } from 'chai'

function keccak(balls: bigint[]) {
    return ethers.solidityPackedKeccak256(
        balls.map((_) => 'uint8'),
        balls,
    )
}

async function deployProxy<
    TContractFactory extends ContractFactory,
    TContract = ReturnType<TContractFactory['deploy']>,
>({
    deployer,
    implementation,
    initData,
}: {
    deployer: Signer
    implementation: { new (runner?: Signer): TContractFactory }
    initData: BytesLike
}): Promise<TContract> {
    const impl = await new implementation(deployer).deploy()
    const proxy = await new ERC1967Proxy__factory(deployer).deploy(
        await impl.getAddress(),
        initData,
    )
    return new implementation(deployer).attach(await proxy.getAddress()) as TContract
}

describe('Lootery', () => {
    let mockRandomiser: MockRandomiser
    let deployer: SignerWithAddress
    let bob: SignerWithAddress
    beforeEach(async () => {
        ;[deployer, bob] = await ethers.getSigners()

        mockRandomiser = await new MockRandomiser__factory(deployer).deploy()
    })

    it('runs happy path', async () => {
        const gamePeriod = BigInt(1 * 60 * 60) // 1h
        const lotto = await deployProxy({
            deployer,
            implementation: Lootery__factory,
            initData: await Lootery__factory.createInterface().encodeFunctionData('init', [
                deployer.address,
                'Lotto',
                'LOTTO',
                5,
                69,
                gamePeriod,
                parseEther('0.1'),
                5000, // 50%
                await mockRandomiser.getAddress(),
            ]),
        })
        // Allow seeding jackpot
        await lotto.seedJackpot({
            value: parseEther('10'),
        })
        expect(await ethers.provider.getBalance(await lotto.getAddress())).to.eq(parseEther('10'))

        const gameId = await lotto.currentGameId()

        // Bob purchases a winning ticket
        const winningTicket = [3n, 11n, 22n, 29n, 42n]
        await lotto.connect(bob).purchase(
            [
                {
                    whomst: bob.address,
                    picks: winningTicket,
                },
            ],
            {
                value: parseEther('0.1'),
            },
        )
        // Bob receives NFT ticket
        expect(await lotto.balanceOf(bob.address)).to.eq(1)
        const ticketTokenId = await lotto.tokenOfOwnerByIndex(bob.address, 0)
        expect(ticketTokenId).to.eq(1)

        // Draw
        await time.increase(gamePeriod)
        await lotto.draw()
        const { requestId } = await lotto.randomnessRequest()
        expect(requestId).to.not.eq(0n)

        // Fulfill w/ mock randomiser
        const fulfilmentTx = await mockRandomiser
            .fulfillRandomWords(requestId, [6942069420])
            .then((tx) => tx.wait(1))
        const [emittedGameId, emittedBalls] = lotto.interface.decodeEventLog(
            'GameFinalised',
            fulfilmentTx?.logs?.[0].data!,
            fulfilmentTx?.logs?.[0].topics,
        ) as unknown as [bigint, bigint[]]
        expect(emittedGameId).to.eq(0)
        expect(emittedBalls).to.deep.eq(winningTicket)
        expect(await lotto.winningPickIds(emittedGameId)).to.eq(keccak(emittedBalls))

        // Bob claims entire pot
        const jackpot = await lotto.jackpots(gameId)
        expect(jackpot).to.eq(parseEther('10.05'))
        const balanceBefore = await ethers.provider.getBalance(bob.address)
        await lotto.claimWinnings(ticketTokenId)
        expect(await ethers.provider.getBalance(bob.address)).to.eq(balanceBefore + jackpot)

        // Withdraw accrued fees
        const accruedFees = await lotto.accruedCommunityFees()
        expect(accruedFees).to.eq(parseEther('0.05'))
        await expect(lotto.withdrawAccruedFees()).to.emit(lotto, 'Transferred')
        expect(await lotto.accruedCommunityFees()).to.eq(0)
    })
})
