import crypto from 'bitcoinjs-lib/src/crypto'
import SwapApp, { constants } from 'swap.app'
import { Flow } from 'swap.swap'


class BCH2ETH extends Flow {

  static getName() {
    return `${constants.COINS.bch}2${constants.COINS.eth}`
  }

  constructor(swap) {
    super(swap)

    this._flowName = BCH2ETH.getName()

    this.ethSwap = SwapApp.swaps[constants.COINS.eth]
    this.bchSwap = SwapApp.swaps[constants.COINS.bch]

    this.myBtcAddress = SwapApp.services.auth.accounts.btc.getAddress()
    this.myEthAddress = SwapApp.services.auth.accounts.eth.address

    this.stepNumbers = {
      'sign': 1,
      'submit-secret': 2,
      'sync-balance': 3,
      'lock-bch': 4,
      'wait-lock-eth': 5,
      'withdraw-eth': 6,
      'finish': 7,
      'end': 8
    }

    if (!this.ethSwap) {
      throw new Error('BCH2ETH: "ethSwap" of type object required')
    }
    if (!this.bchSwap) {
      throw new Error('BCH2ETH: "bchSwap" of type object required')
    }

    this.state = {
      step: 0,

      signTransactionHash: null,
      isSignFetching: false,
      isParticipantSigned: false,

      bchScriptCreatingTransactionHash: null,
      ethSwapCreationTransactionHash: null,

      secretHash: null,
      bchScriptValues: null,

      bchScriptVerified: false,

      isBalanceFetching: false,
      isBalanceEnough: false,
      balance: null,

      isEthContractFunded: false,

      ethSwapWithdrawTransactionHash: null,
      isEthWithdrawn: false,

      refundTransactionHash: null,
      isRefunded: false,

      refundTxHex: null,
      isFinished: false,
      isSwapExist: false,
    }

    super._persistSteps()
    this._persistState()
  }

  _persistState() {
    super._persistState()

    // this.ethSwap.getBalance({
    //   ownerAddress: this.swap.participant.eth.address,
    // })
    //   .then((balance) => {
    //     console.log('balance:', balance)
    //   })
  }

  _getSteps() {
    const flow = this

    return [

      // 1. Signs

      () => {
        flow.swap.room.once('swap sign', () => {
          flow.finishStep({
            isParticipantSigned: true,
          }, { step: 'sign', silentError: true })
        })

        flow.swap.room.once('swap exists', () => {
          flow.setState({
            isSwapExist: true,
          })
        })

        if (flow.state.isSwapExist) {
          flow.swap.room.once('refund completed', () => {
            flow.swap.room.sendMessage({
              event: 'request sign',
            })
          })
        } else {
          flow.swap.room.sendMessage({
            event: 'request sign',
          })
        }
      },
      // 2. Create secret, secret hash

      () => {
        // this.submitSecret()
      },

      // 3. Check balance

      () => {
        this.syncBalance()
        console.log(`sync balance`)
      },

      // 4. Create BCH Script, fund, notify participant

      async () => {
        const { sellAmount, participant } = flow.swap
        let bchScriptCreatingTransactionHash

        // TODO move this somewhere!
        const utcNow = () => Math.floor(Date.now() / 1000)
        const getLockTime = () => utcNow() + 3600 * 3 // 3 hours from now

        const scriptValues = {
          secretHash:         flow.state.secretHash,
          ownerPublicKey:     SwapApp.services.auth.accounts.btc.getPublicKey(),
          recipientPublicKey: participant.btc.publicKey,
          lockTime:           getLockTime(),
        }

        await flow.bchSwap.fundScript({
          scriptValues,
          amount: sellAmount,
        }, (hash) => {
          bchScriptCreatingTransactionHash = hash
          flow.setState({
            bchScriptCreatingTransactionHash: hash,
          })
        })

        flow.swap.room.on('request bch script', () => {
          flow.swap.room.sendMessage({
            event: 'create bch script',
            data: {
              scriptValues,
              bchScriptCreatingTransactionHash,
            }
          })
        })

        flow.swap.room.sendMessage({
          event: 'create bch script',
          data: {
            scriptValues,
            bchScriptCreatingTransactionHash,
          }
        })

        flow.finishStep({
          isBtcScriptFunded: true,
          bchScriptValues: scriptValues,
        }, {  step: 'lock-bch' })
      },

      // 5. Wait participant creates ETH Contract

      () => {
        const { participant } = flow.swap
        let timer

        flow.swap.room.once('create eth contract', ({ ethSwapCreationTransactionHash }) => {
          flow.setState({
            ethSwapCreationTransactionHash,
          })
        })

        const checkEthBalance = () => {
          timer = setTimeout(async () => {
            const balance = await flow.ethSwap.getBalance({
              ownerAddress: participant.eth.address,
            })

            if (balance > 0) {
              if (!flow.state.isEthContractFunded) { // redundant condition but who cares :D
                flow.finishStep({
                  isEthContractFunded: true,
                }, { step: 'wait-lock-eth' })
              }
            }
            else {
              checkEthBalance()
            }
          }, 20 * 1000)
        }

        checkEthBalance()

        flow.swap.room.once('create eth contract', () => {
          if (!flow.state.isEthContractFunded) {
            clearTimeout(timer)
            timer = null

            flow.finishStep({
              isEthContractFunded: true,
            }, { step: 'wait-lock-eth' })
          }
        })
      },

      // 6. Withdraw

      async () => {
        const { buyAmount, participant } = flow.swap

        const data = {
          ownerAddress:   participant.eth.address,
          secret:         flow.state.secret,
        }

        const balanceCheckResult = await flow.ethSwap.checkBalance({
          ownerAddress: participant.eth.address,
          expectedValue: buyAmount,
        })

        if (balanceCheckResult) {
          console.error(`Waiting until deposit: ETH balance check error:`, balanceCheckResult)
          flow.swap.events.dispatch('eth balance check error', balanceCheckResult)
          return
        }

        try {
          await flow.ethSwap.withdraw(data, (hash) => {
            flow.setState({
              ethSwapWithdrawTransactionHash: hash,
            })

            flow.swap.room.sendMessage({
              event: 'ethWithdrawTxHash',
              data: {
                ethSwapWithdrawTransactionHash: hash,
              }
            })

          })
        } catch (err) {
          // TODO user can stuck here after page reload...
          if ( /known transaction/.test(err.message) )
            return console.error(`known tx: ${err.message}`)
          else if ( /out of gas/.test(err.message) )
            return console.error(`tx failed (wrong secret?): ${err.message}`)
          else
            return console.error(err)
        }

        flow.swap.room.on('request ethWithdrawTxHash', () => {
          flow.swap.room.sendMessage({
            event: 'ethWithdrawTxHash',
            data: {
              ethSwapWithdrawTransactionHash: flow.state.ethSwapWithdrawTransactionHash,
            },
          })
        })

        flow.swap.room.sendMessage({
          event: 'finish eth withdraw',
        })

        flow.finishStep({
          isEthWithdrawn: true,
        })
      },

      // 7. Finish

      () => {
        flow.swap.room.once('swap finished', () => {
          flow.finishStep({
            isFinished: true,
          })
        })
      },

      // 8. Finished!
      () => {

      }
    ]
  }

  submitSecret(secret) {
    if (this.state.secret) { return }

    if (!this.state.isParticipantSigned) {
      throw new Error(`Cannot proceed: participant not signed. step=${this.state.step}`)
    }

    const secretHash = crypto.ripemd160(Buffer.from(secret, 'hex')).toString('hex')

    this.finishStep({
      secret,
      secretHash,
    }, { step: 'submit-secret' })
  }

  async syncBalance() {
    const { sellAmount } = this.swap

    this.setState({
      isBalanceFetching: true,
    })

    const balance = await this.bchSwap.fetchBalance(this.myBtcAddress)
    const isEnoughMoney = sellAmount.isLessThanOrEqualTo(balance)

    if (isEnoughMoney) {
      this.finishStep({
        balance,
        isBalanceFetching: false,
        isBalanceEnough: true,
      }, { step: 'sync-balance' })
    }
    else {
      console.error(`Not enough money: ${balance} < ${sellAmount}`)
      this.setState({
        balance,
        isBalanceFetching: false,
        isBalanceEnough: false,
      })
    }
  }

  getRefundTxHex = () => {
    this.bchSwap.getRefundHexTransaction({
      scriptValues: this.state.bchScriptValues,
      secret: this.state.secret,
    })
      .then((txHex) => {
        this.setState({
          refundTxHex: txHex,
        })
      })
  }

  tryRefund() {
    return this.bchSwap.refund({
      scriptValues: this.state.bchScriptValues,
      secret: this.state.secret,
    }, (hash) => {
      this.setState({
        refundTransactionHash: hash,
        isRefunded: true,
      })
    })
      .then(() => {
        this.setState({
          isSwapExist: false,
        })
      })
  }
}


export default BCH2ETH
