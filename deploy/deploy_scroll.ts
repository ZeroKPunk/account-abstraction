import { BlsSignerFactory, aggregate } from "@thehubbleproject/bls/dist/signer";
import { arrayify, hexConcat, keccak256 } from "ethers/lib/utils";
import { ethers } from "hardhat";
import { deployBLSOpen, deployBLSSignatureAggregator, deployEntryPoint, deployTestToken } from "../test/testutils";
import { wrapProvider } from '@account-abstraction/sdk'
import { BLSOpen__factory, BLSSignatureAggregator__factory, BLSWalletDeployer__factory, BLSWallet__factory, TestToken__factory } from "../typechain";
import { SimpleWalletAPI } from '@account-abstraction/sdk'
import { BigNumber } from "ethers";
import { Test } from "mocha";
import { fillUserOp } from "../test/UserOp";
import { UserOperation, UserOpsPerAggragator } from "../test/UserOperation";
import { solG1 } from "@thehubbleproject/bls/dist/mcl";
async function main() {
  const BLS_DOMAIN = arrayify(keccak256(Buffer.from('eip4337.bls.domain')))

  const account0 = (await ethers.getSigners())[0]
  const account1 = (await ethers.getSigners())[1]
  const provider = ethers.provider
  let EntryPoint = await deployEntryPoint()
  console.log(`EntryPoint Address ${EntryPoint.address}`);

  const TestToken = await deployTestToken()
  console.log(`TestToken address ${TestToken.address}`)

  const BLSOpen = await deployBLSOpen()
  console.log(`BLSOpen address: ${BLSOpen.address}`);

  const BLSSignatureAggregator = await deployBLSSignatureAggregator(BLSOpen.address)
  console.log(`BLSSignatureAggregator address: ${BLSSignatureAggregator.address}`)

  const WalletDeployer = await new BLSWalletDeployer__factory(account0).deploy()
  console.log(`WalletDeployer address: ${WalletDeployer.address}`)

  const fact = await BlsSignerFactory.new()
  const signer1 = fact.getSigner(arrayify(BLS_DOMAIN), '0x01')
  const signer2 = fact.getSigner(arrayify(BLS_DOMAIN), '0x02')

  let BlsWallet1 = await new BLSWallet__factory(account0).deploy(EntryPoint.address, BLSSignatureAggregator.address, signer1.pubkey)
  let BlsWallet2 = await new BLSWallet__factory(account0).deploy(EntryPoint.address, BLSSignatureAggregator.address, signer2.pubkey)
  console.log(`wallet1 address: ${BlsWallet1.address}`)
  console.log(`wallet2 address: ${BlsWallet2.address}`)

  await account0.sendTransaction({
    from: account0.address,
    to: BlsWallet1.address,
    value: ethers.utils.parseEther('3')
  })

  await account0.sendTransaction({
    from: account0.address,
    to: BlsWallet2.address,
    value: ethers.utils.parseEther('3')
  })
 

  const account0Token = TestToken__factory.connect(TestToken.address, account0)
  const account1Token = TestToken__factory.connect(TestToken.address, account1)
  const bw1Token = TestToken__factory.connect(TestToken.address, BlsWallet1.signer)
  const bw2Token = TestToken__factory.connect(TestToken.address, BlsWallet2.signer)

  account0Token.mint(account0.address, BigNumber.from(10000))
  // account1Token.mint(account1.address, BigNumber.from(10000))
  const bw0minttx = await bw1Token.mint(BlsWallet1.address, BigNumber.from(10000))
  await bw2Token.mint(BlsWallet2.address, BigNumber.from(10000))
  const bal = await TestToken.balanceOf(BlsWallet1.address)
  console.log(`${BlsWallet1.address} token amount ${bal} ${bw0minttx.hash}`)

  const BATCH_TX = 20
  
  // Normal ERC20 Transfer Start
  let NormalTxGasUsedTotal = BigNumber.from(0)
  for(let i = 0; i < BATCH_TX; i++) {
    let tx = await account0Token.transfer(account1.address, BigNumber.from(1))
    console.log(`Normal transfer ERC20 ${i} ${tx.hash}`)
    await tx.wait()
    const txResult = await provider.getTransactionReceipt(tx.hash)
    console.log(`normalTx txHash ${tx.hash} gasUsed ${JSON.stringify(txResult.gasUsed.toString())}`)
    NormalTxGasUsedTotal = NormalTxGasUsedTotal.add(Number(txResult.gasUsed.toString()))
  }
  console.log(`NormalTxGasUsedTotal ${JSON.stringify(NormalTxGasUsedTotal.toString())}`)
  // Normal ERC20 Transfer End

  const BlsWalletInterface = BLSWallet__factory.createInterface()
  const TestTokenInterface = TestToken__factory.createInterface()
  const dest = TestToken.address
  const value = BigNumber.from(0)
  const data = TestTokenInterface.encodeFunctionData('transfer', [account1.address, BigNumber.from(1)])
  const callData = BlsWalletInterface.encodeFunctionData('execFromEntryPoint', [dest, value, data])
  let userOpList: UserOperation[] = []
  let sigPartsList: solG1[] = []

  for(let i = 0; i < BATCH_TX; i++ ) {
    let tmpOp = await fillUserOp({
      sender: BlsWallet1.address,
      callData: callData,
      nonce: BigNumber.from(i),
    }, EntryPoint)
    const tmpRequestHash = await BLSSignatureAggregator.getRequestId(tmpOp)
    const tmpSigParts = signer1.sign(tmpRequestHash)
    // tmpOp.signature = hexConcat(tmpSigParts)
    sigPartsList.push(tmpSigParts)
    userOpList.push(tmpOp)
  }
  
  let userOpsAgg: UserOpsPerAggragator = {
    userOps: userOpList,
    aggregator: BLSSignatureAggregator.address,
    signature: ''
  }
  const aggSig = aggregate(sigPartsList)
  userOpsAgg.signature = hexConcat(aggSig)

  // console.log(`userOpsAgg ${JSON.stringify(userOpsAgg)}`)

  const tx = await EntryPoint.handleAggregatedOps([userOpsAgg], account0.address)
  await tx.wait()
  const txResult = await provider.getTransactionReceipt(tx.hash)
  console.log(`Aggregate txHash ${tx.hash} gasUsed ${txResult.gasUsed}`)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
