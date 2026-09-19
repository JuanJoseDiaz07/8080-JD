/*
 * Coprocesador de punto flotante conectado al 8080.
 * No depende del DOM: puede usarse desde Node y desde el navegador.
 * El transporte de datos es IEEE-754 binary32 en little-endian.
 */
class FloatingPointCoprocessor {
    constructor(options = {}) {
        this.operationCycles = options.operationCycles || 8;
        this.maxStackDepth = Math.max(4, options.maxStackDepth || 4);
        this.listeners = new Set();
        this.dataDevice = { read: () => this.readData(), write: (value) => this.writeData(value), clockedDevice: this };
        this.controlDevice = { read: () => this.readStatus(), write: (value) => this.writeCommand(value), clockedDevice: this };
        this.reset();
    }

    reset() {
        this.stack = [];
        this.inputBuffer = [];
        this.outputBuffer = [];
        this.outputIndex = 0;
        this.busyCycles = 0;
        this.command = null;
        this.phase = 'idle';
        this.errorFlags = 0;
        this.lastResult = null;
        this.emit('reset');
    }

    onEvent(listener) {
        if (typeof listener === 'function') this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(type, extra = {}) {
        const event = { type, ...extra, snapshot: this.getSnapshot() };
        this.listeners.forEach((listener) => listener(event));
    }

    getDataDevice() { return this.dataDevice; }
    getControlDevice() { return this.controlDevice; }

    tick() {
        if (this.busyCycles <= 0) return;
        this.busyCycles -= 1;
        const elapsed = this.operationCycles - this.busyCycles;
        const phases = ['unpack', 'align', 'operate', 'normalize', 'round'];
        const phaseIndex = Math.min(phases.length - 1, Math.floor((elapsed / this.operationCycles) * phases.length));
        this.phase = this.busyCycles === 0 ? 'ready' : phases[phaseIndex];
        this.emit(this.busyCycles === 0 ? 'complete' : 'tick', { command: this.command });
    }

    readStatus() {
        let status = this.errorFlags;
        if (this.busyCycles > 0) status |= 0x01; // BUSY
        if (this.busyCycles === 0) status |= 0x02; // READY
        return status & 0xFF;
    }

    writeData(value) {
        if (this.busyCycles > 0) {
            this.errorFlags |= 0x04;
            this.emit('error', { reason: 'No se puede cargar un operando mientras la FPU está ocupada.' });
            return;
        }
        this.inputBuffer.push(Number(value) & 0xFF);
        this.emit('data-in', { value: Number(value) & 0xFF });
        if (this.inputBuffer.length === 4) {
            const raw = this.inputBuffer[0] | (this.inputBuffer[1] << 8) | (this.inputBuffer[2] << 16) | (this.inputBuffer[3] << 24);
            const value32 = FloatingPointCoprocessor.rawToFloat32(raw >>> 0);
            if (this.stack.length >= this.maxStackDepth) {
                this.errorFlags |= 0x04;
                this.emit('error', { reason: 'Pila FPU llena.' });
            } else {
                this.stack.push(value32);
                this.emit('push', { value: value32, raw: raw >>> 0 });
            }
            this.inputBuffer = [];
        }
    }

    readData() {
        if (this.busyCycles > 0 || this.outputIndex >= this.outputBuffer.length) return 0xFF;
        const value = this.outputBuffer[this.outputIndex++];
        this.emit('data-out', { value });
        if (this.outputIndex >= this.outputBuffer.length) {
            this.outputBuffer = [];
            this.outputIndex = 0;
        }
        return value;
    }

    writeCommand(command) {
        const opcode = Number(command) & 0xFF;
        if (opcode === 0x0F) {
            this.reset();
            return;
        }
        if (this.busyCycles > 0) {
            this.errorFlags |= 0x04;
            this.emit('error', { reason: 'Comando recibido mientras la FPU está ocupada.' });
            return;
        }
        this.executeCommand(opcode);
    }

    executeCommand(opcode) {
        const originalStack = this.stack.slice();
        this.clearResultFlags();
        let result;

        try {
            switch (opcode) {
                case 0x01: result = this.binary((y, x) => y + x); break; // FADD
                case 0x02: result = this.binary((y, x) => y - x); break; // FSUB
                case 0x03: result = this.binary((y, x) => y * x); break; // FMUL
                case 0x04: result = this.binary((y, x) => y / x, true); break; // FDIV
                case 0x05: result = this.unary((x) => Math.sqrt(x), (x) => x < 0); break; // FSQRT
                case 0x06: result = this.unary((x) => -x); break; // FCHS
                case 0x07: result = this.unary((x) => Math.abs(x)); break; // FABS
                case 0x08: this.compare(); result = null; break; // FCMP
                case 0x09: result = this.duplicateTop(); break; // FLD
                case 0x0A: result = this.exchangeTop(); break; // FXCH
                default:
                    this.errorFlags |= 0x04;
                    this.phase = 'error';
                    this.emit('error', { reason: `Comando FPU inválido: ${opcode.toString(16).toUpperCase()}H.` });
                    return;
            }
        } catch (error) {
            this.stack = originalStack;
            this.errorFlags |= 0x04;
            this.phase = 'error';
            this.emit('error', { reason: error.message });
            return;
        }

        if (result !== null && result !== undefined) {
            const rounded = FloatingPointCoprocessor.toFloat32(result);
            this.stack.push(rounded);
            this.lastResult = rounded;
            this.setResultFlags(rounded, result);
            this.prepareOutput(rounded);
        }
        this.command = opcode;
        this.busyCycles = this.operationCycles;
        this.phase = 'unpack';
        this.emit('command', { command: opcode, result: this.lastResult });
    }

    binary(operation, division = false) {
        if (this.stack.length < 2) throw new Error('Operandos insuficientes en la pila FPU.');
        const x = this.stack.pop();
        const y = this.stack.pop();
        if (division && x === 0) this.errorFlags |= 0x08; // DIV0
        return operation(y, x);
    }

    unary(operation, invalid = () => false) {
        if (this.stack.length < 1) throw new Error('Operando insuficiente en la pila FPU.');
        const x = this.stack.pop();
        if (invalid(x)) this.errorFlags |= 0x04;
        return operation(x);
    }

    compare() {
        if (this.stack.length < 2) throw new Error('Operandos insuficientes en la pila FPU.');
        const x = this.stack.pop();
        const y = this.stack.pop();
        const comparison = y - x;
        if (Number.isNaN(comparison)) this.errorFlags |= 0x04;
        this.setResultFlags(comparison, comparison);
        return null;
    }

    duplicateTop() {
        if (this.stack.length < 1) throw new Error('Operando insuficiente en la pila FPU.');
        return this.stack[this.stack.length - 1];
    }

    exchangeTop() {
        if (this.stack.length < 2) throw new Error('Operandos insuficientes en la pila FPU.');
        const top = this.stack.length - 1;
        const previous = top - 1;
        [this.stack[top], this.stack[previous]] = [this.stack[previous], this.stack[top]];
        return null;
    }

    clearResultFlags() { this.errorFlags &= 0x02; }

    setResultFlags(value, exactValue = value) {
        this.errorFlags &= 0x3F; // conserva los errores de la operación, limpia ZERO/NEG
        if (Number.isNaN(value)) this.errorFlags |= 0x04;
        if (!Number.isFinite(value) && Number.isFinite(exactValue)) this.errorFlags |= 0x10; // OVERFLOW
        if (value === 0 && exactValue !== 0) this.errorFlags |= 0x20; // UNDERFLOW
        if (value === 0) this.errorFlags |= 0x40; // ZERO
        if (Object.is(value, -0) || value < 0) this.errorFlags |= 0x80; // NEG
    }

    prepareOutput(value) {
        const raw = FloatingPointCoprocessor.float32ToRaw(value);
        this.outputBuffer = [raw & 0xFF, (raw >>> 8) & 0xFF, (raw >>> 16) & 0xFF, (raw >>> 24) & 0xFF];
        this.outputIndex = 0;
    }

    getSnapshot() {
        const values = this.stack.slice().reverse().slice(0, 4).map((value) => FloatingPointCoprocessor.decode(value));
        return {
            stack: values,
            inputBuffer: this.inputBuffer.slice(),
            outputBuffer: this.outputBuffer.slice(this.outputIndex),
            busyCycles: this.busyCycles,
            operationCycles: this.operationCycles,
            phase: this.phase,
            command: this.command,
            status: this.readStatus(),
            flags: {
                busy: Boolean(this.readStatus() & 0x01), ready: Boolean(this.readStatus() & 0x02),
                invalid: Boolean(this.readStatus() & 0x04), div0: Boolean(this.readStatus() & 0x08),
                overflow: Boolean(this.readStatus() & 0x10), underflow: Boolean(this.readStatus() & 0x20),
                zero: Boolean(this.readStatus() & 0x40), negative: Boolean(this.readStatus() & 0x80)
            },
            lastResult: this.lastResult === null ? null : FloatingPointCoprocessor.decode(this.lastResult)
        };
    }

    static toFloat32(value) {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setFloat32(0, Number(value), false);
        return view.getFloat32(0, false);
    }

    static float32ToRaw(value) {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setFloat32(0, Number(value), false);
        return view.getUint32(0, false);
    }

    static rawToFloat32(raw) {
        const buffer = new ArrayBuffer(4);
        const view = new DataView(buffer);
        view.setUint32(0, raw >>> 0, false);
        return view.getFloat32(0, false);
    }

    static toUint32(value) { return FloatingPointCoprocessor.float32ToRaw(value); }

    static decode(value) {
        const raw = FloatingPointCoprocessor.float32ToRaw(value);
        const exponent = (raw >>> 23) & 0xFF;
        const mantissa = raw & 0x7FFFFF;
        return {
            value: FloatingPointCoprocessor.rawToFloat32(raw), raw,
            hex: `0x${raw.toString(16).toUpperCase().padStart(8, '0')}`,
            bits: raw.toString(2).padStart(32, '0'), sign: raw >>> 31, exponent,
            unbiasedExponent: exponent === 0 ? -126 : exponent - 127,
            mantissa, mantissaBits: mantissa.toString(2).padStart(23, '0')
        };
    }

    static operate(a, b, operation) {
        const ops = { add: a + b, subtract: a - b, multiply: a * b, divide: b === 0 ? (a === 0 ? NaN : (a > 0 ? Infinity : -Infinity)) : a / b };
        if (!Object.prototype.hasOwnProperty.call(ops, operation)) throw new Error(`Unknown FPU operation: ${operation}`);
        return FloatingPointCoprocessor.decode(FloatingPointCoprocessor.toFloat32(ops[operation]));
    }
}

if (typeof module !== 'undefined') module.exports = FloatingPointCoprocessor;
if (typeof window !== 'undefined') window.FloatingPointCoprocessor = FloatingPointCoprocessor;
