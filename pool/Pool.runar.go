//go:build ignore

// Pool is a single-LP constant-product AMM between BSV and one BSV-21 binary
// token (BRC-162).
//
// On-chain locking script (a BRC-162 value output with no payload):
//
//	0x20 <assetId:32> <push tokenReserve> OP_2DROP || code || OP_RETURN || state
//
// The BSV reserve is the output's satoshi value. The token reserve lives in
// the token prefix and is duplicated in state (TokenReserve), because the
// prefix sits before Rúnar's OP_CODESEPARATOR and is not covered by the
// preimage. The same goes for the asset id, a readonly property compiled into
// the code. The contract never reads the input's prefix; it always writes the
// continuation's prefix from its own copies. Overlays must check prefix ==
// state (and a 32-byte AssetId) once, when a pool is first admitted.
//
// Token outputs (payouts and fees) are BRC-162 value outputs locked with
// P2PKH, holding 1 sat.
//
// Fees (each fixed at deploy, in basis points of amountIn, rounded up, taken
// in the input asset): LpFeeBps to the LP, ValidatorFeeBps to the validator,
// and CommissionBps to whoever relays the swap (a market, or the user's own
// overlay), at the address it names per call. The contract builds every
// output of a Swap itself; a swap carries no arbitrary outputs.
// The script cannot see token inputs, so every method that brings tokens in
// requires the validator's signature: the validator's role is to confirm the
// token inputs are valid and cover the token outputs. Three methods
// (skein-amm 0.13.0, David Case 2026-10-22, docs/AMM.md "The pool rule"):
// Swap, the validator's; Close, the LP's alone, its outputs free (the LP
// spends the LP's own funds); Rescind, the validator's, writing the pool back
// with its ValidatorPubKey cleared (33 zero bytes), which ends its swaps.
//
// The validator's affirmation lives in state (0.13.0): Nonce and Affirmation,
// never assigned, so every continuation carries them. Every pool output is
// self-attesting: ValidatorPubKey is the BRC-42 child of ValidatorIdentity
// keyed by Nonce (first key), and Affirmation is that key's DER signature over
// sha256 of the message (docs/AMM.md "The deploy and the affirmation"). The
// contract never checks either; the lookup does.
package pool

import runar "github.com/icellan/runar/packages/runar-go"

type Pool struct {
	runar.StatefulSmartContract

	TokenReserve runar.Bigint
	// The validator's key rotates: it names its next key on every Swap it
	// signs. The LP's key is the pool's for its life. Payouts go to Hash160 of the current key. Next keys are derived
	// off-chain so wallets can find their payouts from overlay data.
	LpPubKey        runar.PubKey
	ValidatorPubKey runar.PubKey

	// ValidatorIdentity is state only so the compiler keeps it: Rúnar drops
	// unreferenced readonly fields, and the Go DSL has no way to opt out (see
	// docs/notes.md, upstream candidate #6). It is never assigned, so every
	// continuation carries it forward unchanged.
	//
	// It is the validator's stable identity key: who a taker
	// contacts to execute a swap (BRC-103 auth; resolving it to an address is
	// deferred), and the BRC-42 root of the rotating ValidatorPubKey, derived
	// with the `anyone` counterparty: keyed by Nonce for the deploy's key, by
	// the spent pool outpoint for each Swap's next key. The contract never
	// checks the derivation: the validator won't sign a spend that breaks it,
	// and the lookup lists no pool that breaks it.
	ValidatorIdentity runar.PubKey

	// Nonce (32 bytes, the validator's choice at affirm) keys the pool's first
	// validator key; Affirmation is the validator's DER signature of the pool
	// (0.13.0, docs/AMM.md "The deploy and the affirmation"). State only so the
	// compiler keeps them (as ValidatorIdentity); never assigned, so every
	// continuation carries them unchanged. Nonce is Rúnar's fixed 32-byte type
	// (raw in the state, no framing: a variable-length field costs every
	// method a parser, 174 bytes here); Affirmation is a ByteString (DER varies
	// in length), framed in the state by its one-byte push length.
	Nonce       runar.Sha256Digest
	Affirmation runar.ByteString

	// AssetId is the token's canonical 32-byte BRC-162 id (the deploy txid;
	// binary deploys are at output 0). 36-byte legacy ids are not supported.
	AssetId         runar.ByteString `runar:"readonly"`
	LpFeeBps        runar.Bigint     `runar:"readonly"`
	ValidatorFeeBps runar.Bigint     `runar:"readonly"`
	// CommissionBps is the relay's commission. Markets filter pools by it.
	CommissionBps runar.Bigint `runar:"readonly"`
}

// Swap trades amountIn of one asset for the other along x·y = k.
// bsvIn selects the direction. Three fees are taken from amountIn in the
// input asset: the LP fee, the validator fee and the commission, paid to
// commissionPkh (named by the relay per call). Only amountIn minus fees
// enters the pool. A CommissionBps of 0 means no commission output.
//
// Outputs: 0 pool, 1 user payout, then LP fee, validator fee and commission,
// each only when nonzero; then (skein-amm 0.40.0) the taker's token change,
// tokenChange tokens to tokenChangePkh (1 sat), only when nonzero; then
// Rúnar's sats change.
func (c *Pool) Swap(validatorSig runar.Sig, nextValidatorPubKey runar.PubKey, amountIn runar.Bigint, bsvIn runar.Bool, userPkh runar.Addr, commissionPkh runar.Addr, tokenChangePkh runar.Addr, tokenChange runar.Bigint) {
	runar.Assert(runar.CheckSig(validatorSig, c.ValidatorPubKey))
	runar.Assert(amountIn > 0)
	runar.Assert(tokenChange >= 0)
	lpPkh := runar.Hash160(c.LpPubKey)
	validatorPkh := runar.Hash160(c.ValidatorPubKey)

	bsvReserve := runar.ExtractAmount(c.TxPreimage)
	// Fees round up, in the pool's favour: a nonzero rate always takes >= 1.
	lpFee := (amountIn*c.LpFeeBps + 9999) / 10000
	validatorFee := (amountIn*c.ValidatorFeeBps + 9999) / 10000
	commission := (amountIn*c.CommissionBps + 9999) / 10000
	net := amountIn - lpFee - validatorFee - commission
	runar.Assert(net > 0)

	out := net * bsvReserve / (c.TokenReserve + net)
	newBsv := bsvReserve - out
	newTokens := c.TokenReserve + net
	if bsvIn {
		out = net * c.TokenReserve / (bsvReserve + net)
		newBsv = bsvReserve + net
		newTokens = c.TokenReserve - out
	}
	runar.Assert(out > 0)

	c.TokenReserve = newTokens
	c.ValidatorPubKey = nextValidatorPubKey
	c.writePool(newBsv)
	c.AddRawOutput(c.payoutSats(out, !bsvIn), c.payoutScript(out, userPkh, !bsvIn))
	// Scripts computed outside the conditionals: a conditional output whose
	// argument inlines nested branches (payoutScript -> tokenPrefix) trips
	// a Rúnar codegen error. A single level of branching is fine.
	lpScript := c.payoutScript(lpFee, lpPkh, bsvIn)
	validatorScript := c.payoutScript(validatorFee, validatorPkh, bsvIn)
	commissionScript := c.payoutScript(commission, commissionPkh, bsvIn)
	tokenChangeScript := c.tokenP2pkh(tokenChange, tokenChangePkh)
	if lpFee > 0 {
		c.AddRawOutput(c.payoutSats(lpFee, bsvIn), lpScript)
	}
	if validatorFee > 0 {
		c.AddRawOutput(c.payoutSats(validatorFee, bsvIn), validatorScript)
	}
	if commission > 0 {
		c.AddRawOutput(c.payoutSats(commission, bsvIn), commissionScript)
	}
	if tokenChange > 0 {
		c.AddRawOutput(1, tokenChangeScript)
	}
}

// Close ends the pool, the LP's alone (skein-amm 0.13.0, David Case
// 2026-10-22): a plain signature by the LP key, and the outputs are free. The
// LP spends the LP's own funds: the LP's wallet decides where the sats and the
// tokens go (a covenant would protect no one). A position is deployed or
// closed, never resized in place (2026-10-09). No state is written and no
// output is added, so the compiler commits to no output (no hashOutputs check,
// no change parameters).
func (c *Pool) Close(lpSig runar.Sig) {
	runar.Assert(runar.CheckSig(lpSig, c.LpPubKey))
}

// Rescind is the validator's withdrawal of its attestation (0.13.0, David
// Case 2026-10-22; it replaces 0.11.0's validator Close): signed by the current
// ValidatorPubKey, it writes the pool back at output 0 unchanged (the same
// sats, TokenReserve, LpPubKey, ValidatorIdentity, Nonce and Affirmation) with
// ValidatorPubKey cleared to 33 zero bytes. No Swap is possible after it (no
// key can sign against the zero key, nor can a second Rescind), and the lookup
// delists the pool on seeing it; the LP closes it as any pool. The validator
// pays the miner from an input of its own, its change Rúnar's change output:
// nothing is taken from the pool.
func (c *Pool) Rescind(validatorSig runar.Sig) {
	runar.Assert(runar.CheckSig(validatorSig, c.ValidatorPubKey))
	sats := runar.ExtractAmount(c.TxPreimage)
	c.ValidatorPubKey = runar.Num2Bin(0, 33)
	c.writePool(sats)
}

// writePool emits the pool continuation holding bsvReserve.
func (c *Pool) writePool(bsvReserve runar.Bigint) {
	runar.Assert(bsvReserve > 0)
	runar.Assert(c.TokenReserve > 0)
	c.AddRawOutput(bsvReserve, c.poolScript())
}

// poolScript is the pool's locking script for the current state: token
// prefix for TokenReserve, this contract's code (recovered from the preimage
// scriptCode), and the state.
func (c *Pool) poolScript() runar.ByteString {
	// scriptCode = varint || code[2:] || OP_RETURN || state, where state is
	// TokenReserve (8) + LpPubKey, ValidatorPubKey, ValidatorIdentity (33
	// each) + Nonce (32) + Affirmation (its length byte + the DER
	// signature). Every field but TokenReserve and ValidatorPubKey is carried
	// unchanged and those two are fixed-width, so the new state is exactly as
	// long as the spent one.
	//
	// The prefix is built before GetStateScript: Rúnar's codegen treats
	// GetStateScript as the state properties' last use, and a property read
	// after it compiles to the constructor's value (a slot), not the state's.
	prefix := c.tokenPrefix(c.TokenReserve)
	state := c.GetStateScript()
	sc := runar.ExtractScriptCode(c.TxPreimage)
	first := runar.Bin2Num(runar.Cat(runar.Substr(sc, 0, 1), runar.Num2Bin(0, 1)))
	varintLen := runar.Bigint(1)
	if first == 253 {
		varintLen = 3
	}
	body := runar.Substr(sc, varintLen, runar.Len(sc)-varintLen-runar.Len(state))

	// Re-add the two prologue bytes (OP_NOP OP_CODESEPARATOR) that sit
	// before the separator and are therefore not in scriptCode.
	script := runar.Cat(prefix, runar.Cat(runar.ByteString("\x61\xab"), body))
	return runar.Cat(script, state)
}

// payoutSats is the output value for paying amount of BSV (isBsv) or tokens.
func (c *Pool) payoutSats(amount runar.Bigint, isBsv runar.Bool) runar.Bigint {
	sats := runar.Bigint(1)
	if isBsv {
		sats = amount
	}
	return sats
}

// payoutScript pays amount of BSV (isBsv) or tokens to pkh.
func (c *Pool) payoutScript(amount runar.Bigint, pkh runar.Addr, isBsv runar.Bool) runar.ByteString {
	s := p2pkh(pkh)
	if !isBsv {
		s = c.tokenP2pkh(amount, pkh)
	}
	return s
}

// tokenP2pkh is a BRC-162 value output of amount to pkh (no payload).
func (c *Pool) tokenP2pkh(amount runar.Bigint, pkh runar.Addr) runar.ByteString {
	return runar.Cat(c.tokenPrefix(amount), p2pkh(pkh))
}

// tokenPrefix is the BRC-162 value-output prefix push(assetId) push(amount)
// OP_2DROP, with no payload. The id push length is fixed at 32 bytes; the
// amount is minimally pushed (OP_1..OP_16 for small values). Callers only
// emit it for amount > 0 (a zero amount would be an authority output);
// zero-amount scripts are built but never output.
func (c *Pool) tokenPrefix(amount runar.Bigint) runar.ByteString {
	push := runar.Num2Bin(runar.Clamp(amount, 0, 16)+80, 1) // OP_1..OP_16
	if amount > 16 {
		amt := runar.Pack(amount)
		push = runar.Cat(runar.Num2Bin(runar.Len(amt), 1), amt)
	}
	prefix := runar.Cat(runar.ByteString("\x20"), c.AssetId)
	return runar.Cat(prefix, runar.Cat(push, runar.ByteString("\x6d")))
}

func p2pkh(pkh runar.Addr) runar.ByteString {
	return runar.Cat(runar.ByteString("\x76\xa9\x14"), runar.Cat(pkh, runar.ByteString("\x88\xac")))
}
