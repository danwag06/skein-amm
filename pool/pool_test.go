package pool

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"
	"github.com/icellan/runar/compilers/go/compiler"
	runar "github.com/icellan/runar/packages/runar-go"
)

// These tests hand-build transactions and run input 0 (the pool) through the
// go-sdk interpreter with the real BIP-143 preimage. Rúnar's SDK call helpers
// don't understand a locking-script prefix yet, so they are bypassed.

// The contract's public methods in declaration order (its ABI's method
// index): Swap, Close and Rescind (skein-amm 0.13.0; 0.9.0: AddLiquidity and
// RemoveLiquidity are gone).
const (
	methodSwap = iota
	methodClose
	methodRescind
)

// The attestation every pool output carries in state (0.13.0): the nonce and a
// stand-in DER signature (the contract never checks either; gen/vectors signs a
// real one).
var (
	nonce       = bytes.Repeat([]byte{0x4e}, 32)
	affirmation = append([]byte{0x30, 0x44}, bytes.Repeat([]byte{0x02}, 0x44)...)
)

// assetID is a canonical BRC-162 token id: the 32-byte deploy txid.
var assetID = bytes.Repeat([]byte{0xa5}, 32)

var validatorIdentity = key(nil, 0x7f)

type fixture struct {
	code          []byte // compiled code with readonly args spliced in (no state)
	userPkh       []byte
	commissionPkh []byte // the relay's payout address, passed per swap
	changePkh     []byte // the taker's token change key hash (0.40.0), passed per swap
	lpFeeBps      int64
	validatorBps  int64
	commissionBps int64
}

func newFixture(t *testing.T, lpFeeBps, validatorBps, commissionBps int64) *fixture {
	t.Helper()
	art, err := compiler.CompileFromSource("Pool.runar.go")
	if err != nil {
		t.Fatal(err)
	}
	js, err := compiler.ArtifactToJSON(art)
	if err != nil {
		t.Fatal(err)
	}
	var sa runar.RunarArtifact
	if err := json.Unmarshal(js, &sa); err != nil {
		t.Fatal(err)
	}
	f := &fixture{
		userPkh:       bytes.Repeat([]byte{0x33}, 20),
		commissionPkh: bytes.Repeat([]byte{0x44}, 20),
		changePkh:     bytes.Repeat([]byte{0x55}, 20),
		lpFeeBps:      lpFeeBps,
		validatorBps:  validatorBps,
		commissionBps: commissionBps,
	}

	// State values don't affect the code part; any will do.
	p := pool{tokens: 1000, lp: key(t, 1), validator: key(t, 2)}
	c := runar.NewRunarContract(&sa, []interface{}{
		p.tokens,
		hex.EncodeToString(p.lp.PubKey().Compressed()),
		hex.EncodeToString(p.validator.PubKey().Compressed()),
		hex.EncodeToString(validatorIdentity.PubKey().Compressed()),
		hex.EncodeToString(nonce),
		hex.EncodeToString(affirmation),
		hex.EncodeToString(assetID),
		lpFeeBps,
		validatorBps,
		commissionBps,
	})
	full, _ := hex.DecodeString(c.GetLockingScript())
	tail := append([]byte{0x6a}, p.state()...)
	if !bytes.HasSuffix(full, tail) {
		t.Fatalf("SDK state layout differs from pool.state(): %x", full[len(full)-len(tail):])
	}
	f.code = full[:len(full)-len(tail)]
	t.Logf("pool code with its args: %d bytes; a pool output's script: %d bytes", len(f.code), len(f.poolScript(pool{tokens: 5_000_000, lp: key(t, 1), validator: key(t, 2)})))
	return f
}

// key stands in for an off-chain deterministic derivation: key n of a party.
func key(t *testing.T, n byte) *ec.PrivateKey {
	k, _ := ec.PrivateKeyFromBytes(bytes.Repeat([]byte{n}, 32))
	return k
}

// next is the party's following key in its derivation sequence.
func next(k *ec.PrivateKey) *ec.PrivateKey { return key(nil, k.Serialize()[0]+1) }

func pkh(k *ec.PrivateKey) []byte { return k.PubKey().Hash() }

// --- script building (mirrors the contract) ---

func scriptNum(n int64) []byte {
	var b []byte
	for n > 0 {
		b = append(b, byte(n&0xff))
		n >>= 8
	}
	if len(b) > 0 && b[len(b)-1]&0x80 != 0 {
		b = append(b, 0)
	}
	return b
}

// pushNum is a minimal push of a number (-1 as OP_1NEGATE, other negatives
// as sign-magnitude).
func pushNum(n int64) []byte {
	switch {
	case n == -1:
		return []byte{0x4f}
	case n < 0:
		b := scriptNum(-n)
		if b[len(b)-1]&0x80 != 0 {
			b = append(b, 0x80)
		} else {
			b[len(b)-1] |= 0x80
		}
		return append([]byte{byte(len(b))}, b...)
	case n == 0:
		return []byte{0x00}
	case n <= 16:
		return []byte{byte(0x50 + n)}
	}
	b := scriptNum(n)
	return append([]byte{byte(len(b))}, b...)
}

func pushData(b []byte) []byte {
	s, _ := hex.DecodeString(runar.EncodePushData(hex.EncodeToString(b)))
	return s
}

func pushBool(v bool) []byte {
	if v {
		return []byte{0x51}
	}
	return []byte{0x00}
}

// tokenPrefix is the BRC-162 value-output prefix with no payload:
// push(assetId) push(amount) OP_2DROP.
func tokenPrefix(amount int64) []byte {
	p := append([]byte{0x20}, assetID...)
	p = append(p, pushNum(amount)...)
	return append(p, 0x6d)
}

// state is TokenReserve (8, LE) || LpPubKey || ValidatorPubKey ||
// ValidatorIdentity (33 each) || Nonce (32) || Affirmation (its length, then
// the DER). newFixture checks this against the SDK. A rescinded pool's
// ValidatorPubKey is 33 zero bytes (`rescinded`).
func (p pool) state() []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, uint64(p.tokens))
	b = append(b, p.lp.PubKey().Compressed()...)
	if p.rescinded {
		b = append(b, make([]byte, 33)...)
	} else {
		b = append(b, p.validator.PubKey().Compressed()...)
	}
	b = append(b, validatorIdentity.PubKey().Compressed()...)
	b = append(b, nonce...)
	b = append(b, byte(len(affirmation)))
	return append(b, affirmation...)
}

func p2pkh(pkh []byte) []byte {
	return append(append([]byte{0x76, 0xa9, 0x14}, pkh...), 0x88, 0xac)
}

func (f *fixture) poolScript(p pool) []byte {
	s := append(tokenPrefix(p.tokens), f.code...)
	s = append(s, 0x6a)
	return append(s, p.state()...)
}

func tokenP2pkh(amount int64, pkh []byte) []byte {
	return append(tokenPrefix(amount), p2pkh(pkh)...)
}

// --- spending ---

type pool struct {
	bsv, tokens   int64
	lp, validator *ec.PrivateKey // current keys
	rescinded     bool           // ValidatorPubKey cleared (Rescind)
	lock          []byte         // defaults to poolScript(pool)
}

type out struct {
	sats   int64
	script []byte
}

type call struct {
	method int
	args   [][]byte // pushes, in ABI order, excluding implicit params
	outs   []out
	// signers produce sigs over the real preimage; placed at sigSlots in args.
	signers  []*ec.PrivateKey
	sigSlots []int
	// poolIndex is the pool's input index (0 by convention; not enforced).
	poolIndex int
	// change is Rúnar's change output (_changePKH, _changeAmount), the last
	// output, when the call names one.
	change *struct {
		pkh  []byte
		sats int64
	}
}

// separatorScriptCode is the locking script after the pool's OP_CODESEPARATOR.
func separatorScriptCode(lock []byte) []byte {
	off := 1 + 32 // push assetId
	switch op := lock[off]; {
	case op >= 0x51 && op <= 0x60:
		off++
	default:
		off += 1 + int(op)
	}
	off++ // OP_2DROP
	if lock[off] != 0x61 || lock[off+1] != 0xab {
		panic("separator not where expected")
	}
	return lock[off+2:]
}

func (f *fixture) run(t *testing.T, p pool, c call) error {
	t.Helper()
	lock := p.lock
	if lock == nil {
		lock = f.poolScript(p)
	}
	prevOut := &transaction.TransactionOutput{Satoshis: uint64(p.bsv), LockingScript: script.NewFromBytes(lock)}

	tx := transaction.NewTransaction()
	prevTxid, _ := chainhash.NewHashFromHex(strings.Repeat("11", 32))
	fundTxid, _ := chainhash.NewHashFromHex(strings.Repeat("22", 32))
	poolIn := &transaction.TransactionInput{SourceTXID: prevTxid, SourceTxOutIndex: 0, SequenceNumber: 0xffffffff}
	poolIn.SetSourceTxOutput(prevOut)
	// A funding / token input. Not executed here: the validator vouches for it.
	fundIn := &transaction.TransactionInput{SourceTXID: fundTxid, SourceTxOutIndex: 0, SequenceNumber: 0xffffffff}
	if c.poolIndex == 0 {
		tx.AddInput(poolIn)
		tx.AddInput(fundIn)
	} else {
		tx.AddInput(fundIn)
		tx.AddInput(poolIn)
	}
	pi := c.poolIndex
	for _, o := range c.outs {
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(o.sats), LockingScript: script.NewFromBytes(o.script)})
	}

	cp := tx.ShallowClone()
	cp.Inputs[pi].SetSourceTxOutput(&transaction.TransactionOutput{Satoshis: uint64(p.bsv), LockingScript: script.NewFromBytes(separatorScriptCode(lock))})
	pre, err := cp.CalcInputPreimage(uint32(pi), sighash.AllForkID)
	if err != nil {
		t.Fatal(err)
	}
	h1 := sha256.Sum256(pre)
	digest := sha256.Sum256(h1[:])

	args := append([][]byte{}, c.args...)
	for i, k := range c.signers {
		sig, err := k.Sign(digest[:])
		if err != nil {
			t.Fatal(err)
		}
		args[c.sigSlots[i]] = pushData(append(sig.Serialize(), 0x41))
	}

	var u []byte
	u = append(u, pushData(f.code)...) // _codePart
	for _, a := range args {
		u = append(u, a...)
	}
	if c.method != methodClose { // Close adds no output: no change parameters (0.13.0)
		changePkh, change := make([]byte, 20), int64(0) // _changeAmount 0: no change output
		if c.change != nil {
			changePkh, change = c.change.pkh, c.change.sats
		}
		u = append(u, pushData(changePkh)...)
		u = append(u, pushNum(change)...)
	}
	u = append(u, pushData(pre)...) // txPreimage
	u = append(u, pushNum(int64(c.method))...)
	tx.Inputs[pi].UnlockingScript = script.NewFromBytes(u)

	return interpreter.NewEngine().Execute(
		interpreter.WithTx(tx, pi, prevOut),
		interpreter.WithForkID(),
		interpreter.WithAfterGenesis(),
		interpreter.WithAfterChronicle(),
	)
}

// --- expected results (reference math) ---

type swapResult struct {
	out, lpFee, validatorFee, commission, newBsv, newTokens int64
	nextValidator                                           *ec.PrivateKey
}

func (r swapResult) pool(p pool) pool {
	return pool{bsv: r.newBsv, tokens: r.newTokens, lp: p.lp, validator: r.nextValidator}
}

func (f *fixture) expectSwap(p pool, amountIn int64, bsvIn bool) swapResult {
	r := swapResult{
		lpFee:         (amountIn*f.lpFeeBps + 9999) / 10000,
		validatorFee:  (amountIn*f.validatorBps + 9999) / 10000,
		commission:    (amountIn*f.commissionBps + 9999) / 10000,
		nextValidator: next(p.validator),
	}
	net := amountIn - r.lpFee - r.validatorFee - r.commission
	if bsvIn {
		r.out = net * p.tokens / (p.bsv + net)
		r.newBsv, r.newTokens = p.bsv+net, p.tokens-r.out
	} else {
		r.out = net * p.bsv / (p.tokens + net)
		r.newBsv, r.newTokens = p.bsv-r.out, p.tokens+net
	}
	return r
}

// swapCall builds a swap paying the commission (if any) to f.commissionPkh,
// with no token change (tokenChange 0: f.changePkh named, no output) and no
// sats change.
func (f *fixture) swapCall(p pool, amountIn int64, bsvIn bool, r swapResult) call {
	// Fees are paid to the keys current at this spend.
	outs := []out{{r.newBsv, f.poolScript(r.pool(p))}}
	// fee pays a fee in the input asset: sats for BSV in, a 1-sat token
	// output for tokens in.
	fee := func(amount int64, to []byte) {
		if amount == 0 {
			return
		}
		if bsvIn {
			outs = append(outs, out{amount, p2pkh(to)})
		} else {
			outs = append(outs, out{1, tokenP2pkh(amount, to)})
		}
	}
	if bsvIn {
		outs = append(outs, out{1, tokenP2pkh(r.out, f.userPkh)})
	} else {
		outs = append(outs, out{r.out, p2pkh(f.userPkh)})
	}
	fee(r.lpFee, pkh(p.lp))
	fee(r.validatorFee, pkh(p.validator))
	fee(r.commission, f.commissionPkh)
	return call{
		method: methodSwap,
		args: [][]byte{nil, pushData(r.nextValidator.PubKey().Compressed()), pushNum(amountIn), pushBool(bsvIn),
			pushData(f.userPkh), pushData(f.commissionPkh), pushData(f.changePkh), pushNum(0)},
		outs:     outs,
		signers:  []*ec.PrivateKey{p.validator},
		sigSlots: []int{0},
	}
}

func mustPass(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
}

func mustFail(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected failure")
	}
	t.Logf("rejected: %v", err)
}

// --- tests ---

func TestSwap(t *testing.T) {
	f := newFixture(t, 30, 5, 0) // 0.30% LP, 0.05% validator, no commission
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}

	for _, bsvIn := range []bool{true, false} {
		name := map[bool]string{true: "bsv in", false: "tokens in"}[bsvIn]
		r := f.expectSwap(p, 20_000, bsvIn)

		t.Run(name+": pays out along the curve with fees", func(t *testing.T) {
			if r.lpFee == 0 || r.validatorFee == 0 {
				t.Fatalf("fixture should exercise both fees: %+v", r)
			}
			mustPass(t, f.run(t, p, f.swapCall(p, 20_000, bsvIn, r)))
		})
		t.Run(name+": product does not decrease", func(t *testing.T) {
			if r.newBsv*r.newTokens < p.bsv*p.tokens {
				t.Fatalf("k decreased: %d -> %d", p.bsv*p.tokens, r.newBsv*r.newTokens)
			}
		})
		t.Run(name+": user takes one more than the curve allows", func(t *testing.T) {
			bad := r
			bad.out++
			if bsvIn {
				bad.newTokens--
			} else {
				bad.newBsv--
			}
			mustFail(t, f.run(t, p, f.swapCall(p, 20_000, bsvIn, bad)))
		})
		t.Run(name+": legacy bug, full amountIn into the pool", func(t *testing.T) {
			bad := r
			if bsvIn {
				bad.newBsv = p.bsv + 20_000
			} else {
				bad.newTokens = p.tokens + 20_000
			}
			mustFail(t, f.run(t, p, f.swapCall(p, 20_000, bsvIn, bad)))
		})
		t.Run(name+": validator signature from the wrong key", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			c.signers = []*ec.PrivateKey{p.lp}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": validator fee paid to the next key instead of the current", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			last := &c.outs[len(c.outs)-1]
			if bsvIn {
				last.script = p2pkh(pkh(r.nextValidator))
			} else {
				last.script = tokenP2pkh(r.validatorFee, pkh(r.nextValidator))
			}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": LP key changes on a swap", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			moved := r.pool(p)
			moved.lp = next(p.lp)
			c.outs[0].script = f.poolScript(moved)
			mustFail(t, f.run(t, p, c))
		})
	}

	t.Run("chained swaps rotate the validator key", func(t *testing.T) {
		r1 := f.expectSwap(p, 20_000, true)
		mustPass(t, f.run(t, p, f.swapCall(p, 20_000, true, r1)))
		p2 := r1.pool(p)
		r2 := f.expectSwap(p2, 50_000, false)
		mustPass(t, f.run(t, p2, f.swapCall(p2, 50_000, false, r2)))

		t.Run("old validator key can no longer sign", func(t *testing.T) {
			c := f.swapCall(p2, 50_000, false, r2)
			c.signers = []*ec.PrivateKey{p.validator}
			mustFail(t, f.run(t, p2, c))
		})
	})

	t.Run("tiny swap still pays each fee at least 1, OP_n amount pushes", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		r := f.expectSwap(small, 3, true) // fees 1 + 1, net 1, out = 5000/1001 = 4
		if r.lpFee != 1 || r.validatorFee != 1 || r.out > 16 {
			t.Fatalf("fixture should hit minimum fees and a small push: %+v", r)
		}
		mustPass(t, f.run(t, small, f.swapCall(small, 3, true, r)))
	})
	t.Run("rounded-down fees are rejected", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		bad := f.expectSwap(small, 3, true)
		bad.lpFee, bad.validatorFee = 0, 0
		net := int64(3)
		bad.out = net * small.tokens / (small.bsv + net)
		bad.newBsv, bad.newTokens = small.bsv+net, small.tokens-bad.out
		mustFail(t, f.run(t, small, f.swapCall(small, 3, true, bad)))
	})
	t.Run("fees consume the whole swap", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		r := f.expectSwap(small, 2, true) // 1 + 1 in fees, net 0
		mustFail(t, f.run(t, small, f.swapCall(small, 2, true, r)))
	})

	t.Run("continuation without the token prefix", func(t *testing.T) {
		r := f.expectSwap(p, 20_000, true)
		c := f.swapCall(p, 20_000, true, r)
		c.outs[0].script = c.outs[0].script[len(tokenPrefix(r.newTokens)):]
		mustFail(t, f.run(t, p, c))
	})
	t.Run("continuation with the wrong amount in the prefix", func(t *testing.T) {
		r := f.expectSwap(p, 20_000, true)
		c := f.swapCall(p, 20_000, true, r)
		lock := append(tokenPrefix(r.newTokens+1), f.code...)
		c.outs[0].script = append(append(lock, 0x6a), r.pool(p).state()...)
		mustFail(t, f.run(t, p, c))
	})
	t.Run("continuation with the wrong amount in state", func(t *testing.T) {
		r := f.expectSwap(p, 20_000, true)
		c := f.swapCall(p, 20_000, true, r)
		bad := r.pool(p)
		bad.tokens++
		lock := append(tokenPrefix(r.newTokens), f.code...)
		c.outs[0].script = append(append(lock, 0x6a), bad.state()...)
		mustFail(t, f.run(t, p, c))
	})
	t.Run("continuation with a payload after the prefix", func(t *testing.T) {
		// The pool writes no payload; a continuation carrying one is not
		// the script the contract built.
		r := f.expectSwap(p, 20_000, true)
		c := f.swapCall(p, 20_000, true, r)
		lock := append(tokenPrefix(r.newTokens), 0x00, 0x75) // OP_0 OP_DROP
		lock = append(lock, f.code...)
		c.outs[0].script = append(append(lock, 0x6a), r.pool(p).state()...)
		mustFail(t, f.run(t, p, c))
	})

	t.Run("input prefix is never read", func(t *testing.T) {
		// Prefix disagrees with state; the contract trusts state. Overlays
		// must reject such a pool when it is first admitted.
		r := f.expectSwap(p, 20_000, true)
		lying := p
		lying.lock = append(tokenPrefix(999_999_999), f.code...)
		lying.lock = append(append(lying.lock, 0x6a), p.state()...)
		mustPass(t, f.run(t, lying, f.swapCall(p, 20_000, true, r)))
	})
}

func TestSwapZeroFeeRates(t *testing.T) {
	f := newFixture(t, 0, 0, 0)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}
	for _, bsvIn := range []bool{true, false} {
		r := f.expectSwap(p, 20_000, bsvIn)
		if r.lpFee != 0 || r.validatorFee != 0 {
			t.Fatalf("zero rates should mean zero fees: %+v", r)
		}
		mustPass(t, f.run(t, p, f.swapCall(p, 20_000, bsvIn, r))) // no fee outputs
	}
}

// closeCall is the LP's Close (0.13.0): the LP key's signature, the outputs
// whatever the LP's wallet chose (here the sats to one key, the tokens to
// another, as the pages do: a BRC-29 key and a module receiving key).
func (f *fixture) closeCall(p pool) call {
	return call{
		method: methodClose,
		args:   [][]byte{nil},
		outs: []out{
			{p.bsv - 500, p2pkh(pkh(key(nil, 60)))},
			{1, tokenP2pkh(p.tokens, pkh(key(nil, 61)))},
		},
		signers:  []*ec.PrivateKey{p.lp},
		sigSlots: []int{0},
	}
}

func TestClose(t *testing.T) {
	f := newFixture(t, 30, 5, 0)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}

	t.Run("the LP: outputs of the LP's choosing", func(t *testing.T) {
		mustPass(t, f.run(t, p, f.closeCall(p)))
	})
	t.Run("the LP: everything to one key, a fee from the pool's sats", func(t *testing.T) {
		c := f.closeCall(p)
		c.outs = []out{{p.bsv - 300, p2pkh(pkh(p.lp))}, {1, tokenP2pkh(p.tokens, pkh(p.lp))}}
		mustPass(t, f.run(t, p, c))
	})
	t.Run("the LP: a single unrelated output (the contract does not look)", func(t *testing.T) {
		c := f.closeCall(p)
		c.outs = []out{{1, p2pkh(pkh(key(t, 62)))}}
		mustPass(t, f.run(t, p, c))
	})
	t.Run("the LP: a continuation kept is just an output (the lookup never lists it)", func(t *testing.T) {
		c := f.closeCall(p)
		c.outs = append([]out{{p.bsv - 500, f.poolScript(p)}}, c.outs[1:]...)
		mustPass(t, f.run(t, p, c))
	})
	t.Run("the validator's signature: refused (0.13.0: it rescinds instead)", func(t *testing.T) {
		c := f.closeCall(p)
		c.signers[0] = p.validator
		mustFail(t, f.run(t, p, c))
	})
	t.Run("another key: refused", func(t *testing.T) {
		c := f.closeCall(p)
		c.signers[0] = key(t, 50)
		mustFail(t, f.run(t, p, c))
	})
	t.Run("a rescinded pool closes the same", func(t *testing.T) {
		r := p
		r.rescinded = true
		mustPass(t, f.run(t, r, f.closeCall(r)))
	})
}

// rescindCall is the validator's Rescind (0.13.0): output 0 the pool written
// back with ValidatorPubKey cleared, then Rúnar's change from the validator's
// own funding input (`run` adds that input; its value is not checked here).
func (f *fixture) rescindCall(p pool) call {
	r := p
	r.rescinded = true
	ch := &struct {
		pkh  []byte
		sats int64
	}{pkh(key(nil, 0x77)), 49_000}
	return call{
		method:   methodRescind,
		args:     [][]byte{nil},
		outs:     []out{{p.bsv, f.poolScript(r)}, {ch.sats, p2pkh(ch.pkh)}},
		signers:  []*ec.PrivateKey{p.validator},
		sigSlots: []int{0},
		change:   ch,
	}
}

func TestRescind(t *testing.T) {
	f := newFixture(t, 30, 5, 0)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}
	r := p
	r.rescinded = true

	t.Run("the validator: the pool written back, its key cleared", func(t *testing.T) {
		mustPass(t, f.run(t, p, f.rescindCall(p)))
	})
	t.Run("no change output", func(t *testing.T) {
		c := f.rescindCall(p)
		c.outs, c.change = c.outs[:1], nil
		mustPass(t, f.run(t, p, c))
	})
	t.Run("the LP's signature: refused", func(t *testing.T) {
		c := f.rescindCall(p)
		c.signers[0] = p.lp
		mustFail(t, f.run(t, p, c))
	})
	t.Run("the key kept, not cleared", func(t *testing.T) {
		c := f.rescindCall(p)
		c.outs[0].script = f.poolScript(p)
		mustFail(t, f.run(t, p, c))
	})
	t.Run("the key moved to another, not cleared", func(t *testing.T) {
		c := f.rescindCall(p)
		moved := p
		moved.validator = next(p.validator)
		c.outs[0].script = f.poolScript(moved)
		mustFail(t, f.run(t, p, c))
	})
	t.Run("sats taken from the pool", func(t *testing.T) {
		c := f.rescindCall(p)
		c.outs[0].sats--
		mustFail(t, f.run(t, p, c))
	})
	t.Run("tokens changed", func(t *testing.T) {
		c := f.rescindCall(p)
		less := r
		less.tokens--
		c.outs[0].script = f.poolScript(less)
		mustFail(t, f.run(t, p, c))
	})
	t.Run("the LP key changed", func(t *testing.T) {
		c := f.rescindCall(p)
		other := r
		other.lp = key(t, 50)
		c.outs[0].script = f.poolScript(other)
		mustFail(t, f.run(t, p, c))
	})
	t.Run("no continuation", func(t *testing.T) {
		c := f.rescindCall(p)
		c.outs = c.outs[1:]
		mustFail(t, f.run(t, p, c))
	})
	t.Run("an extra output past the change", func(t *testing.T) {
		c := f.rescindCall(p)
		c.outs = append(c.outs, out{1, p2pkh(pkh(key(t, 50)))})
		mustFail(t, f.run(t, p, c))
	})
	t.Run("a rescinded pool: no Swap can be signed", func(t *testing.T) {
		res := f.expectSwap(p, 20_000, true)
		c := f.swapCall(p, 20_000, true, res)
		// The continuation as Swap would write it from the rescinded pool.
		for _, signer := range []*ec.PrivateKey{p.validator, p.lp, key(t, 50)} {
			c.signers = []*ec.PrivateKey{signer}
			mustFail(t, f.run(t, r, c))
		}
	})
	t.Run("a rescinded pool: no second Rescind", func(t *testing.T) {
		c := f.rescindCall(r)
		mustFail(t, f.run(t, r, c))
	})
}

// AddLiquidity and RemoveLiquidity are gone (David Case, 2026-10-09): the
// ABI has Swap, Close and Rescind (0.13.0), and a call of method index 3 is
// refused.
func TestNoLiquidityMethods(t *testing.T) {
	art, err := compiler.CompileFromSource("Pool.runar.go")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, m := range art.ABI.Methods {
		if m.IsPublic {
			names = append(names, m.Name)
		}
	}
	if strings.Join(names, ",") != "swap,close,rescind" {
		t.Fatalf("public methods: %v", names)
	}
	f := newFixture(t, 30, 5, 0)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}
	after := pool{bsv: p.bsv + 10_000, tokens: p.tokens + 50_000, lp: next(p.lp), validator: next(p.validator)}
	mustFail(t, f.run(t, p, call{
		method: 3,
		args: [][]byte{nil, nil, pushData(after.lp.PubKey().Compressed()), pushData(after.validator.PubKey().Compressed()),
			pushNum(10_000), pushNum(50_000)},
		outs:     []out{{after.bsv, f.poolScript(after)}},
		signers:  []*ec.PrivateKey{p.lp, p.validator},
		sigSlots: []int{0, 1},
	}))
}

func TestSwapCommission(t *testing.T) {
	f := newFixture(t, 30, 5, 10) // 0.10% commission
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}

	for _, bsvIn := range []bool{true, false} {
		name := map[bool]string{true: "bsv in", false: "tokens in"}[bsvIn]
		r := f.expectSwap(p, 20_000, bsvIn)
		base := f.swapCall(p, 20_000, bsvIn, r)

		t.Run(name+": commission output after the LP and validator fees", func(t *testing.T) {
			if r.commission != 20 || len(base.outs) != 5 {
				t.Fatalf("expected a 20-unit commission as the fifth output: %+v, %d outputs", r, len(base.outs))
			}
			mustPass(t, f.run(t, p, base))
		})
		t.Run(name+": net excludes the commission", func(t *testing.T) {
			net := int64(20_000) - r.lpFee - r.validatorFee - r.commission
			if bsvIn && r.newBsv != p.bsv+net || !bsvIn && r.newTokens != p.tokens+net {
				t.Fatalf("pool did not take exactly net %d: %+v", net, r)
			}
			// The commission entering the pool instead of being paid out.
			bad := r
			if bsvIn {
				bad.newBsv += r.commission
			} else {
				bad.newTokens += r.commission
			}
			c := f.swapCall(p, 20_000, bsvIn, bad)
			c.outs = c.outs[:4]
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": commission missing", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			c.outs = c.outs[:4]
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": commission to a different pkh than the argument", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			other := pkh(key(t, 50))
			if bsvIn {
				c.outs[4].script = p2pkh(other)
			} else {
				c.outs[4].script = tokenP2pkh(r.commission, other)
			}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": relay names its own pkh", func(t *testing.T) {
			g := *f
			g.commissionPkh = pkh(key(t, 50))
			mustPass(t, g.run(t, p, g.swapCall(p, 20_000, bsvIn, r)))
		})
		t.Run(name+": commission underpaid", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			if bsvIn {
				c.outs[4].sats--
			} else {
				c.outs[4].script = tokenP2pkh(r.commission-1, f.commissionPkh)
			}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": commission in the wrong asset", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			if bsvIn {
				c.outs[4] = out{1, tokenP2pkh(r.commission, f.commissionPkh)}
			} else {
				c.outs[4] = out{r.commission, p2pkh(f.commissionPkh)}
			}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": commission before the validator fee", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			c.outs[3], c.outs[4] = c.outs[4], c.outs[3]
			mustFail(t, f.run(t, p, c))
		})
	}

	t.Run("tiny swap rounds the commission up to 1", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		r := f.expectSwap(small, 4, true) // fees 1 + 1 + 1, net 1
		if r.commission != 1 || r.out == 0 {
			t.Fatalf("expected a commission of 1: %+v", r)
		}
		mustPass(t, f.run(t, small, f.swapCall(small, 4, true, r)))
	})
	t.Run("fees including the commission consume the whole swap", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		r := f.expectSwap(small, 3, true) // 1 + 1 + 1, net 0
		mustFail(t, f.run(t, small, f.swapCall(small, 3, true, r)))
	})
}

func TestSwapZeroCommission(t *testing.T) {
	f := newFixture(t, 30, 5, 0)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}
	for _, bsvIn := range []bool{true, false} {
		name := map[bool]string{true: "bsv in", false: "tokens in"}[bsvIn]
		r := f.expectSwap(p, 20_000, bsvIn)
		base := f.swapCall(p, 20_000, bsvIn, r)
		t.Run(name+": no commission output", func(t *testing.T) {
			if r.commission != 0 || len(base.outs) != 4 {
				t.Fatalf("expected pool, payout and two fee outputs: %+v, %d outputs", r, len(base.outs))
			}
			mustPass(t, f.run(t, p, base))
		})
		t.Run(name+": a zero-value commission output is rejected", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			c.outs = append(c.outs, out{0, p2pkh(f.commissionPkh)})
			mustFail(t, f.run(t, p, c))
		})
	}
}

// withChange is a swap call with tokenChange tokens to f.changePkh (the output
// after the fees, when nonzero) and sats change to satsPkh (Rúnar's change, the
// last output, when nonzero).
func (f *fixture) withChange(c call, tokenChange int64, satsPkh []byte, sats int64) call {
	c.args = append([][]byte{}, c.args...)
	c.args[len(c.args)-1] = pushNum(tokenChange)
	if tokenChange != 0 {
		c.outs = append(append([]out{}, c.outs...), out{1, tokenP2pkh(tokenChange, f.changePkh)})
	}
	if sats != 0 {
		c.outs = append(c.outs, out{sats, p2pkh(satsPkh)})
		c.change = &struct {
			pkh  []byte
			sats int64
		}{satsPkh, sats}
	}
	return c
}

// The taker's token change (skein-amm 0.40.0): Swap writes one more token
// output, tokenChange tokens to tokenChangePkh (1 sat), after the commission and
// before Rúnar's sats change, exactly when tokenChange is nonzero.
func TestSwapChange(t *testing.T) {
	f := newFixture(t, 30, 5, 10)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}
	satsPkh := pkh(key(t, 70))
	for _, bsvIn := range []bool{true, false} {
		name := map[bool]string{true: "bsv in", false: "tokens in"}[bsvIn]
		r := f.expectSwap(p, 20_000, bsvIn)
		base := f.swapCall(p, 20_000, bsvIn, r)

		t.Run(name+": neither change", func(t *testing.T) {
			mustPass(t, f.run(t, p, f.withChange(base, 0, nil, 0)))
		})
		t.Run(name+": token change", func(t *testing.T) {
			c := f.withChange(base, 7_777, nil, 0)
			if len(c.outs) != 6 {
				t.Fatalf("expected the token change as the sixth output: %d outputs", len(c.outs))
			}
			mustPass(t, f.run(t, p, c))
		})
		t.Run(name+": sats change", func(t *testing.T) {
			mustPass(t, f.run(t, p, f.withChange(base, 0, satsPkh, 12_345)))
		})
		t.Run(name+": both, the token change before the sats change", func(t *testing.T) {
			c := f.withChange(base, 3, satsPkh, 12_345) // 3: an OP_3 amount push
			mustPass(t, f.run(t, p, c))
			n := len(c.outs)
			c.outs[n-2], c.outs[n-1] = c.outs[n-1], c.outs[n-2]
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": token change named, its output missing", func(t *testing.T) {
			c := f.withChange(base, 7_777, nil, 0)
			c.outs = c.outs[:len(c.outs)-1]
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": token change output with no argument", func(t *testing.T) {
			c := base
			c.outs = append(append([]out{}, base.outs...), out{1, tokenP2pkh(7_777, f.changePkh)})
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": token change of another amount", func(t *testing.T) {
			c := f.withChange(base, 7_777, nil, 0)
			c.outs[len(c.outs)-1].script = tokenP2pkh(7_778, f.changePkh)
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": token change to another key", func(t *testing.T) {
			c := f.withChange(base, 7_777, nil, 0)
			c.outs[len(c.outs)-1].script = tokenP2pkh(7_777, pkh(key(t, 71)))
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": token change of more than 1 sat", func(t *testing.T) {
			c := f.withChange(base, 7_777, nil, 0)
			c.outs[len(c.outs)-1].sats = 2
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": a negative token change", func(t *testing.T) {
			c := base
			c.args = append([][]byte{}, base.args...)
			c.args[len(c.args)-1] = pushNum(-5)
			mustFail(t, f.run(t, p, c))
		})
	}
}
