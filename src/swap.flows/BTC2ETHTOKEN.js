import debug from 'debug'
import crypto from 'bitcoinjs-lib/src/crypto'
import SwapApp, { constants, util } from 'swap.app'
import { Flow } from 'swap.swap'
import { BigNumber } from 'bignumber.js'


export default (tokenName) => {

  class BTC2ETHTOKEN extends Flow {

    static getName() {
      return `${this.getFromName()}2${this.getToName()}`
    }
    static getFromName() {
      return constants.COINS.btc
    }
    static getToName() {
      return tokenName.toUpperCase()
    }
    constructor(swap) {
      super(swap)

      this._flowName = BTC2ETHTOKEN.getName()

      this.stepNumbers = {
        'sign': 1,
        'submit-secret': 2,
        'sync-balance': 3,
        'lock-btc': 4,
        'wait-lock-eth': 5,
        'withdraw-eth': 6,
        'finish': 7,
        'end': 8
      }

      this.ethTokenSwap = swap.ownerSwap
      this.btcSwap      = swap.participantSwap

      if (!this.ethTokenSwap) {
        throw new Error('BTC2ETH: "ethTokenSwap" of type object required')
      }
      if (!this.btcSwap) {
        throw new Error('BTC2ETH: "btcSwap" of type object required')
      }

      this.state = {
        step: 0,

        signTransactionHash: null,
        isSignFetching: false,
        isParticipantSigned: false,

        btcScriptCreatingTransactionHash: null,
        ethSwapCreationTransactionHash: null,

        secretHash: null,
        btcScriptValues: null,

        btcScriptVerified: false,

        isBalanceFetching: false,
        isBalanceEnough: false,
        balance: null,

        isEthContractFunded: false,

        ethSwapWithdrawTransactionHash: null,
        canCreateEthTransaction: true,
        isEthWithdrawn: false,

        refundTxHex: null,
        isFinished: false,
        isSwapExist: false,
      }

      super._persistSteps()
      this._persistState()
    }

    _persistState() {
      super._persistState()
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

        // 2. Create secret, secret hash and BTC script

        () => {
          // this.submitSecret()
        },

        // 3. Check system wallet balance

        () => {
          this.syncBalance()
        },

        // 4. Fund BTC Script if balance enough - else infinity loop BTC balance check, notify participant

        async () => {
          const { sellAmount } = flow.swap

          const onBTCFuncSuccess = (txID) => {
            flow.setState({
              btcScriptCreatingTransactionHash: txID,
            })

            flow.swap.room.on('request btc script', () => {
              flow.swap.room.sendMessage({
                event:  'create btc script',
                data: {
                  scriptValues: flow.state.btcScriptValues,
                  btcScriptCreatingTransactionHash : txID,
                }
              })
            })

            flow.swap.room.sendMessage({
              event: 'create btc script',
              data: {
                scriptValues: flow.state.btcScriptValues,
                btcScriptCreatingTransactionHash : txID,
              }
            })

            flow.finishStep({
              isBtcScriptFunded: true,
            }, {  step: 'lock-btc' })
          }

          // Balance on system wallet enough
          if (flow.state.isBalanceEnough) {
            await flow.btcSwap.fundScript({
              scriptValues: flow.state.btcScriptValues,
              amount: sellAmount,
            }, (hash) => {
              onBTCFuncSuccess(hash)
            })
          } else {
            const { btcScriptValues: scriptValues } = flow.state

            const checkBTCScriptBalanceName = `${flow.swap.id}.checkBTCScriptBalance`

            const checkBTCScriptBalance = async (currentKey) => {
              if (!util.actualKey.compare(this.app, checkBTCScriptBalanceName, currentKey)) {
                return false
              }

              const expected = {
                value: sellAmount.times(1e8)
              }

              const fundingTxHash = await this.btcSwap.checkScriptFunded(scriptValues, expected)

              if (fundingTxHash) {
                util.actualKey.remove(this.app, checkBTCScriptBalanceName)
                return fundingTxHash
              } else {
                return null
              }
            }

            const checkBTCScriptBalanceKey = util.actualKey.create(this.app, checkBTCScriptBalanceName)

            const txID = await util.helpers.repeatAsyncUntilResult(() =>
              checkBTCScriptBalance(checkBTCScriptBalanceKey),
            )

            onBTCFuncSuccess(txID)
          }
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

          flow.waitEthBalance().then( (balance) => {
            if (balance > 0) {
              if (!flow.state.isEthContractFunded) { // redundant condition but who cares :D
                flow.finishStep({
                  isEthContractFunded: true,
                }, { step: 'wait-lock-eth' })
              }
            }
          } );

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
          const { secretHash } = flow.state

          const data = {
            ownerAddress:   participant.eth.address,
            secret:         flow.state.secret,
          }

          const balanceCheckError = await flow.ethTokenSwap.checkBalance({
            ownerAddress: participant.eth.address,
            participantAddress: this.app.services.auth.accounts.eth.address,
            expectedValue: buyAmount,
            expectedHash: secretHash,
          })

          if (balanceCheckError) {
            console.error('Waiting until deposit: ETH balance check error:', balanceCheckError)
            flow.swap.events.dispatch('eth balance check error', balanceCheckError)

            return
          }

          const targetWallet = await flow.ethTokenSwap.getTargetWallet( participant.eth.address )
          const needTargetWallet = (flow.swap.destinationBuyAddress)
            ? flow.swap.destinationBuyAddress
            : this.app.services.auth.accounts.eth.address

          if (targetWallet != needTargetWallet) {
            console.error(
              "Destination address for tokens dismatch with needed (Needed, Getted). Stop swap now!",
              needTargetWallet,
              targetWallet,
            )

            flow.swap.events.dispatch('address for tokens invalid', {
              needed: needTargetWallet,
              getted: targetWallet,
            })

            return
          }

          const onWithdrawReady = () => {
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
          }

          const tryWithdrawKeyName = `${flow.swap.id}.tryWithdraw`

          const tryWithdraw = async (currentKey) => {
            if (!util.actualKey.compare(this.app, tryWithdrawKeyName, currentKey)) {
              return false
            }

            if (!flow.state.isEthWithdrawn) {
              try {
                const withdrawNeededGas = await flow.ethTokenSwap.calcWithdrawGas({
                  ownerAddress: data.ownerAddress,
                  secret: data.secret,
                })
                flow.setState({
                  withdrawFee: withdrawNeededGas
                })

                debug('swap.core:flow')('withdraw gas fee', withdrawNeededGas)

                await flow.ethTokenSwap.withdraw(data, (hash) => {
                  flow.setState({
                    ethSwapWithdrawTransactionHash: hash,
                    canCreateEthTransaction: true,
                  })

                  // Spot where there was an a vulnerability
                  flow.swap.room.sendMessage({
                    event: 'ethWithdrawTxHash',
                    data: {
                      ethSwapWithdrawTransactionHash: hash,
                    }
                  })

                  util.actualKey.remove(this.app, tryWithdrawKeyName)
                })
              } catch (err) {
                if ( /known transaction/.test(err.message) ) {
                  console.error(`known tx: ${err.message}`)
                } else if ( /out of gas/.test(err.message) ) {
                  console.error(`tx failed (wrong secret?): ${err.message}`)
                } else if ( /insufficient funds for gas/.test(err.message) ) {
                  console.error(`insufficient fund for gas: $(err.message)`)
                  debug('swap.core:flow')('insufficient fund for gas... wait fund or request other side to withdraw')

                  flow.setState({
                    requireWithdrawFee: true,
                  })

                  flow.swap.room.once('withdraw ready', ({ethSwapWithdrawTransactionHash}) => {
                    flow.setState({
                      ethSwapWithdrawTransactionHash,
                    })
                    onWithdrawReady()
                  })
                } else {
                  console.error(err)
                }

                flow.setState({
                  canCreateEthTransaction: false,
                })

                return null
              }
            }

            return true
          }

          const tryWithdrawKey = util.actualKey.create(this.app, tryWithdrawKeyName)

          const isEthWithdrawn = await util.helpers.repeatAsyncUntilResult(() =>
            tryWithdraw(tryWithdrawKey),
          )

          if (isEthWithdrawn) {
            onWithdrawReady()
          }
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

    sendWithdrawRequest() {
      const flow = this

      if (!this.state.requireWithdrawFee) return
      if (this.state.requireWithdrawFeeSended) return

      this.setState({
        requireWithdrawFeeSended: true,
      })

      this.swap.room.on('accept withdraw request', () => {
        flow.swap.room.sendMessage({
          event: 'do withdraw',
          data: {
            secret: flow.state.secret,
          }
        })
      })

      this.swap.room.sendMessage({
        event: 'request withdraw',
      })
    }

    async waitEthBalance() {
      const flow = this;
      const participant = this.swap.participant;

      return new Promise((resolve, reject) => {
        const checkEthBalance =  async () => {
          const balance = await flow.ethTokenSwap.getBalance({
            ownerAddress: participant.eth.address,
          })
          if (balance > 0) {
            resolve( balance );
          }
          else {
            setTimeout( checkEthBalance, 20 * 1000 );
          }
        }

        checkEthBalance()
      } );
    }

    submitSecret(secret) {
      if (this.state.secretHash) { return }

      if (!this.state.isParticipantSigned) {
        throw new Error(`Cannot proceed: participant not signed. step=${this.state.step}`)
      }

      const secretHash = crypto.ripemd160(Buffer.from(secret, 'hex')).toString('hex')

      /* Secret hash generated - create BTC script - and only after this notify other part */
      this.createWorkBTCScript(secretHash);

      const _secret = `0x${secret.replace(/^0x/, '')}`

      this.finishStep({
        secret: _secret,
        secretHash,
      }, { step: 'submit-secret' })
    }

    getBTCScriptAddress() {
      return this.state.scriptAddress;
    }
    createWorkBTCScript(secretHash) {
      if (this.state.btcScriptValues) {
        debug('swap.core:flow')('BTC Script already generated', this.state.btcScriptValues);
        return;
      }
      const { participant } = this.swap
      // TODO move this somewhere!
      const utcNow = () => Math.floor(Date.now() / 1000)
      const getLockTime = () => utcNow() + 3600 * 3 // 3 hours from now

      const scriptValues = {
        secretHash:         secretHash,
        ownerPublicKey:     this.app.services.auth.accounts.btc.getPublicKey(),
        recipientPublicKey: participant.btc.publicKey,
        lockTime:           getLockTime(),
      }
      const scriptData = this.btcSwap.createScript(scriptValues)

      this.setState( {
        scriptAddress : scriptData.scriptAddress,
        btcScriptValues: scriptValues,
        scriptBalance : 0,
        scriptUnspendBalance : 0
      } );
    }

    async checkScriptBalance() {
      debug('swap.core:flow')("BTC2ETHTOKEN checkScriptBalance - nothing do - empty :p - wait infinity loop");
    }

    async syncBalance() {
      const { sellAmount } = this.swap

      this.setState({
        isBalanceFetching: true,
      })

      const balance = await this.btcSwap.fetchBalance(this.app.services.auth.accounts.btc.getAddress())
      const isEnoughMoney = sellAmount.isLessThanOrEqualTo(balance)

      if (!isEnoughMoney) {
        console.error(`Not enough money: ${balance} < ${sellAmount}`)
      }
      this.finishStep({
        balance,
        isBalanceFetching: false,
        isBalanceEnough: isEnoughMoney,
      }, { step: 'sync-balance' })
    }

    getRefundTxHex = () => {
      this.btcSwap.getRefundHexTransaction({
        scriptValues: this.state.btcScriptValues,
        secret: this.state.secret,
      })
        .then((txHex) => {
          this.setState({
            refundTxHex: txHex,
          })
        })
    }

    tryRefund() {
      return this.btcSwap.refund({
        scriptValues: this.state.btcScriptValues,
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

    async tryWithdraw(_secret) {
      const { secret, secretHash, isEthWithdrawn, isBtcWithdrawn } = this.state

      if (!_secret)
        throw new Error(`Withdrawal is automatic. For manual withdrawal, provide a secret`)

      if (secret && secret != _secret)
        console.warn(`Secret already known and is different. Are you sure?`)

      if (isEthWithdrawn)
        console.warn(`Looks like money were already withdrawn, are you sure?`)

      debug('swap.core:flow')(`WITHDRAW using secret = ${_secret}`)

      const _secretHash = crypto.ripemd160(Buffer.from(_secret, 'hex')).toString('hex')

      if (secretHash != _secretHash)
        console.warn(`Hash does not match! state: ${secretHash}, given: ${_secretHash}`)

      const { participant } = this.swap

      const data = {
        ownerAddress:   participant.eth.address,
        secret:         _secret,
      }

      await this.ethTokenSwap.withdraw(data, (hash) => {
        debug('swap.core:flow')(`TX hash=${hash}`)
        this.setState({
          ethSwapWithdrawTransactionHash: hash,
          canCreateEthTransaction: true,
        })
      }).then(() => {

        this.finishStep({
          isEthWithdrawn: true,
        }, 'withdraw-eth')
      })
    }
  }

  return BTC2ETHTOKEN
}
