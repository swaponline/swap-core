import debug from 'debug'
import SwapApp, { constants, SwapInterface, util } from 'swap.app'
import BigNumber from 'bignumber.js'
import InputDataDecoder from 'ethereum-input-data-decoder'


class EthSwap extends SwapInterface {

  /**
   *
   * @param {object}    options
   * @param {string}    options.address
   * @param {array}     options.abi
   * @param {number}    options.gasLimit
   * @param {function}  options.fetchBalance
   */
  constructor(options) {
    super()

    if (typeof options.fetchBalance !== 'function') {
      throw new Error('EthSwap: "fetchBalance" required')
    }
    if (typeof options.address !== 'string') {
      throw new Error('EthSwap: "address" required')
    }
    if (!Array.isArray(options.abi)) {
      throw new Error('EthSwap: "abi" required')
    }
    if (typeof options.estimateGasPrice !== 'function') {
      // ({ speed } = {}) => gasPrice
      console.warn(`EthTokenSwap: "estimateGasPrice" is not a function. You will not be able use automatic mempool-based fee`)
    }

    this.address        = options.address
    this.abi            = options.abi

    this._swapName      = constants.COINS.eth
    this.gasLimit       = options.gasLimit || 3e5
    this.gasPrice       = options.gasPrice || 2e9
    this.fetchBalance   = options.fetchBalance
    this.estimateGasPrice = options.estimateGasPrice || (() => {})
  }

  _initSwap(app) {
    super._initSwap(app)

    this.app = app

    this.decoder  = new InputDataDecoder(this.abi)
    this.contract = new this.app.env.web3.eth.Contract(this.abi, this.address)
  }

  async updateGas() {
    try {
      this.gasPrice = await this.estimateGasPrice()
    } catch(err) {
      debug('swap.core:swaps')(`EthSwap: Error with gas update: ${err.message}, using old value gasPrice=${this.gasPrice}`)
    }
  }

  /**
   *
   * @param {object} data
   * @param {string} data.secretHash
   * @param {string} data.participantAddress
   * @param {string} data.targetWallet
   * @param {number} data.amount
   * @param {function} handleTransactionHash
   * @returns {Promise}
   */
  async create(data, handleTransactionHash) {
    if (data.targetWallet && (data.targetWallet!==data.participantAddress) && this.hasTargetWallet()) {
      return this.createSwapTarget(data, handleTransactionHash)
    } else {
      return this.createSwap(data, handleTransactionHash)
    }
  }

  /**
   *
   * @param {object} data
   * @param {string} data.secretHash
   * @param {string} data.participantAddress
   * @param {string} data.targetWallet
   * @param {number} data.amount
   * @param {function} handleTransactionHash
   * @returns {Promise}
   */
  async createSwap(data, handleTransactionHash) {
    const { secretHash, participantAddress, amount } = data

    debug('swap.core:swaps')('create before', this.gasPrice)

    await this.updateGas()

    debug('swap.core:swaps')('create after', this.gasPrice)

    const base = BigNumber(10).pow(18)
    const newAmount = new BigNumber(amount.toString()).times(base).integerValue().toNumber()

    return new Promise(async (resolve, reject) => {
      const hash = `0x${secretHash.replace(/^0x/, '')}`

      const params = {
        from: this.app.services.auth.accounts.eth.address,
        gas: this.gasLimit,
        value: newAmount,
        gasPrice: this.gasPrice,
      }

      const values  = [ hash, participantAddress ]

      debug('swap.core:swaps')('params', params)

      const gasFee = await this.contract.methods.createSwap(...values).estimateGas(params)
      params.gas = gasFee
      console.log("EthSwap -> createSwap -> gasFee",gasFee)

      const receipt = await this.contract.methods.createSwap(...values).send(params)
        .on('transactionHash', (hash) => {
          if (typeof handleTransactionHash === 'function') {
            handleTransactionHash(hash)
          }
        })
        .on('error', (err) => {
          reject(err)
        })

      resolve(receipt)
    })
  }

  /**
   *
   * @param {object} data
   * @param {string} data.secretHash
   * @param {string} data.participantAddress
   * @param {string} data.targetWallet
   * @param {number} data.amount
   * @param {function} handleTransactionHash
   * @returns {Promise}
   */
  async createSwapTarget(data, handleTransactionHash) {
    const { secretHash, participantAddress, amount, targetWallet } = data

    await this.updateGas()

    const base = BigNumber(10).pow(18)
    const newAmount = new BigNumber(amount.toString()).times(base).integerValue().toNumber()

    return new Promise(async (resolve, reject) => {
      const hash = `0x${secretHash.replace(/^0x/, '')}`

      const params = {
        from: this.app.services.auth.accounts.eth.address,
        gas: this.gasLimit,
        value: newAmount,
        gasPrice: this.gasPrice,
      }

      const values  = [ hash , participantAddress, targetWallet ]

      const gasFee = await this.contract.methods.createSwapTarget(...values).estimateGas(params)
      params.gas = gasFee
      console.log("EthSwap -> createSwapTarget -> gasFee",gasFee)

      const receipt = await this.contract.methods.createSwapTarget(...values).send(params)
        .on('transactionHash', (hash) => {
          if (typeof handleTransactionHash === 'function') {
            handleTransactionHash(hash)
          }
        })
        .on('error', (err) => {
          reject(err)
        })

      resolve(receipt)
    })
  }
  /**
   *
   * @param {object} data
   * @param {string} data.ownerAddress
   * @returns {Promise}
   */
  getBalance(data) {
    const { ownerAddress } = data

    return new Promise(async (resolve, reject) => {
      let balance

      try {
        balance = await this.contract.methods.getBalance(ownerAddress).call({
          from: this.app.services.auth.accounts.eth.address,
        })
      }
      catch (err) {
        reject(err)
      }

      resolve(balance)
    })
  }

  /**
   *
   * @param {object} data
   * @param {string} data.ownerAddress
   * @param {string} data.participantAddress
   * @returns {Promise}
   */
  checkSwapExists(data) {
    const { ownerAddress, participantAddress } = data

    return new Promise(async (resolve, reject) => {
      let swap

      try {
        swap = await this.contract.methods.swaps(ownerAddress, participantAddress).call()
      }
      catch (err) {
        reject(err)
        return
      }

      debug('swap.core:swaps')('swapExists', swap)

      const balance = swap ? parseInt(swap.balance) : 0
      resolve(balance > 0)
    })
  }

  /**
   *
   * @param {object} data
   * @param {string} data.ownerAddress
   * @param {BigNumber} data.expectedValue
   * @returns {Promise.<string>}
   */
  async checkBalance(data) {
    const { ownerAddress, participantAddress, expectedValue, expectedHash } = data

    const balance = await util.helpers.repeatAsyncUntilResult(() =>
      this.getBalance({ ownerAddress })
    )
    const swap = await util.helpers.repeatAsyncUntilResult(() =>
      this.contract.methods.swaps(ownerAddress, participantAddress).call()
    )

    const { secretHash } = swap
    debug('swap.core:swaps')(`swap.secretHash`, secretHash)

    const _secretHash = `${secretHash.replace(/^0x/, '')}`

    debug('swap.core:swaps')(`secretHash: expected hash = ${expectedHash}, contract hash = ${_secretHash}`)

    if (expectedHash !== _secretHash) {
      return `Expected hash: ${expectedHash}, got: ${_secretHash}`
    }

    const expectedValueWei = BigNumber(expectedValue).times(1e18).toNumber()

    if (expectedValueWei < balance) {
      return `Expected value: ${expectedValueWei}, got: ${balance}`
    }
  }

  /**
   *
   * @returns {boolean}
   */
  hasTargetWallet() {
    return !!this.contract.methods.getTargetWallet
  }

  /**
   *
   * @param {string} ownerAddress
   * @returns {Promise.<string>}
   */
  async getTargetWallet(ownerAddress) {
    console.log('EthSwap->getTargetWallet');
    let address = await util.helpers.repeatAsyncUntilResult(() =>
      this.getTargetWalletPromise(ownerAddress)
    )
    return address
  }

  /**
   *
   * @param {string} ownerAddress
   * @param {number} repeatCount
   * @returns {string}
   */
  async getTargetWalletPromise(ownerAddress) {
    return new Promise(async (resolve, reject) => {
      try {
        const targetWallet = await this.contract.methods.getTargetWallet(ownerAddress).call({
          from: this.app.services.auth.accounts.eth.address,
        })

        resolve(targetWallet)
      }
      catch (err) {
        reject(err)
      }
    });
  }

  /**
   *
   * @param {object} data
   * @param {string} data.secret
   * @param {string} data.ownerAddress
   * @param {function} handleTransactionHash
   * @returns {Promise}
   */
  async withdraw(data, handleTransactionHash) {
    const { ownerAddress, secret } = data

    await this.updateGas()

    return new Promise(async (resolve, reject) => {
      const _secret = `0x${secret.replace(/^0x/, '')}`

      const params = {
        from: this.app.services.auth.accounts.eth.address,
        gas: this.gasLimit,
        gasPrice: this.gasPrice,
      }

      const gasFee = await this.contract.methods.withdraw(_secret, ownerAddress).estimateGas(params);
      console.log("EthSwap -> withdraw -> gasFee",gasFee);
      params.gas = gasFee;

      const receipt = await this.contract.methods.withdraw(_secret, ownerAddress).send(params)
        .on('transactionHash', (hash) => {
          if (typeof handleTransactionHash === 'function') {
            handleTransactionHash(hash)
          }
        })
        .on('error', (err) => {
          reject(err)
        })

      resolve(receipt)
    })
  }

  /**
   *
   * @param {object} data
   * @param {string} data.participantAddress
   * @param {function} handleTransactionHash
   * @returns {Promise}
   */
  async refund(data, handleTransactionHash) {
    const { participantAddress } = data

    await this.updateGas()

    return new Promise(async (resolve, reject) => {
      const params = {
        from: this.app.services.auth.accounts.eth.address,
        gas: this.gasLimit,
        gasPrice: this.gasPrice,
      }

      const receipt = await this.contract.methods.refund(participantAddress).send(params)
        .on('transactionHash', (hash) => {
          if (typeof handleTransactionHash === 'function') {
            handleTransactionHash(hash)
          }
        })
        .on('error', (err) => {
          reject(err)
        })

      resolve(receipt)
    })
  }

  /**
   *
   * @param {object} data
   * @param {string} data.participantAddress
   * @returns {Promise}
   */
  getSecret(data) {
    const { participantAddress } = data

    return new Promise(async (resolve, reject) => {
      try {
        const secret = await this.contract.methods.getSecret(participantAddress).call({
          from: this.app.services.auth.accounts.eth.address,
        })

        debug('swap.core:swaps')('secret ethswap.js', secret)

        const secretValue = secret && !/^0x0+$/.test(secret) ? secret : null

        resolve(secretValue)
      }
      catch (err) {
        reject(err)
      }
    })
  }


/*
  Function: withdraw(bytes32 _secret, address _ownerAddress)
  bytes32 {...}
  inputs: (2) […]
    0: Uint8Array(32) [ 208, 202, 170, … ]
    1: "e918c8719bae0525786548b8da7fbef9b33d4e25"
  name: "withdraw"
  types: (2) […]
    0: "bytes32"
    1: "address"
*/

  /**
   *
   * @param {string} transactionHash
   * @returns {Promise<any>}
   */
  getSecretFromTxhash = (transactionHash) =>
    util.helpers.repeatAsyncUntilResult(() =>
      this.app.env.web3.eth.getTransaction(transactionHash)
        .then(txResult => {
          try {
            const bytes32 = this.decoder.decodeData(txResult.input)
            return this.app.env.web3.utils.bytesToHex(bytes32.inputs[0]).split('0x')[1]
          } catch (err) {
            debug('swap.core:swaps')('Trying to fetch secret from tx: ' + err.message)
            return
          }
        })
    )
}


export default EthSwap
