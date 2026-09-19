class Intel8080 {
    constructor() {
        this.memory = new Uint8Array(65536);
        this.devices = new Map();
        this.clockedDevices = new Set();
        this.ioListeners = new Set();
        this.reset();
    }

    reset() {
        this.registers = {
            a: 0,
            b: 0,
            c: 0,
            d: 0,
            e: 0,
            h: 0,
            l: 0,
            sp: 0xFFFF,
            pc: 0
        };
        this.flags = {
            s: false,
            z: false,
            ac: false,
            p: false,
            cy: false
        };
        this.halted = false;
        this.lastInstructionAddress = 0;
        if (this.memory) {
            this.memory.fill(0);
        }
        const resetTargets = new Set([...this.devices.values(), ...this.clockedDevices]);
        resetTargets.forEach((device) => {
            if (device && typeof device.reset === 'function') device.reset();
            if (device && device.clockedDevice && typeof device.clockedDevice.reset === 'function') device.clockedDevice.reset();
        });
    }

    /** Registra un dispositivo de E/S en un puerto de 8 bits. */
    attachDevice(port, device) {
        const normalizedPort = Number(port) & 0xFF;
        this.devices.set(normalizedPort, device || {});
        if (device && device.clockedDevice) this.clockedDevices.add(device.clockedDevice);
        if (device && typeof device.tick === 'function') this.clockedDevices.add(device);
        return this;
    }

    detachDevice(port) {
        const normalizedPort = Number(port) & 0xFF;
        const device = this.devices.get(normalizedPort);
        this.devices.delete(normalizedPort);
        if (device && device.clockedDevice && ![...this.devices.values()].some((item) => item.clockedDevice === device.clockedDevice)) {
            this.clockedDevices.delete(device.clockedDevice);
        }
        return device;
    }

    onIO(listener) {
        if (typeof listener === 'function') this.ioListeners.add(listener);
        return () => this.ioListeners.delete(listener);
    }

    notifyIO(event) {
        this.ioListeners.forEach((listener) => listener(event));
    }

    readPort(port, instructionAddress = this.lastInstructionAddress) {
        const normalizedPort = Number(port) & 0xFF;
        const device = this.devices.get(normalizedPort);
        let value = 0xFF;
        if (device && typeof device.read === 'function') {
            try { value = Number(device.read()) & 0xFF; } catch (error) { value = 0xFF; }
        }
        this.notifyIO({ direction: 'IN', port: normalizedPort, value, address: instructionAddress & 0xFFFF });
        return value;
    }

    writePort(port, value, instructionAddress = this.lastInstructionAddress) {
        const normalizedPort = Number(port) & 0xFF;
        const normalizedValue = Number(value) & 0xFF;
        const device = this.devices.get(normalizedPort);
        if (device && typeof device.write === 'function') {
            try { device.write(normalizedValue); } catch (error) { /* Los dispositivos no deben detener al CPU. */ }
        }
        this.notifyIO({ direction: 'OUT', port: normalizedPort, value: normalizedValue, address: instructionAddress & 0xFFFF });
    }

    tickDevices() {
        this.clockedDevices.forEach((device) => {
            if (device && typeof device.tick === 'function') device.tick();
        });
    }

    getRP(rp) {
        switch (rp) {
            case 'bc': return (this.registers.b << 8) | this.registers.c;
            case 'de': return (this.registers.d << 8) | this.registers.e;
            case 'hl': return (this.registers.h << 8) | this.registers.l;
            case 'sp': return this.registers.sp;
            default: return 0;
        }
    }

    setRP(rp, value) {
        value &= 0xFFFF;
        switch (rp) {
            case 'bc':
                this.registers.b = (value >> 8) & 0xFF;
                this.registers.c = value & 0xFF;
                break;
            case 'de':
                this.registers.d = (value >> 8) & 0xFF;
                this.registers.e = value & 0xFF;
                break;
            case 'hl':
                this.registers.h = (value >> 8) & 0xFF;
                this.registers.l = value & 0xFF;
                break;
            case 'sp':
                this.registers.sp = value;
                break;
        }
    }

    getFlagByte() {
        let res = 0x02;
        if (this.flags.s) res |= 0x80;
        if (this.flags.z) res |= 0x40;
        if (this.flags.ac) res |= 0x10;
        if (this.flags.p) res |= 0x04;
        if (this.flags.cy) res |= 0x01;
        return res;
    }

    setFlagByte(val) {
        this.flags.s = (val & 0x80) !== 0;
        this.flags.z = (val & 0x40) !== 0;
        this.flags.ac = (val & 0x10) !== 0;
        this.flags.p = (val & 0x04) !== 0;
        this.flags.cy = (val & 0x01) !== 0;
    }

    updateFlags(val, setAC = false, acVal = 0) {
        val &= 0xFF;
        this.flags.z = (val === 0);
        this.flags.s = (val & 0x80) !== 0;
        this.flags.p = this.checkParity(val);
        if (setAC) {
            this.flags.ac = acVal;
        }
    }

    checkParity(val) {
        let count = 0;
        for (let i = 0; i < 8; i++) {
            if (val & (1 << i)) count++;
        }
        return (count % 2 === 0);
    }

    readMemory(addr) {
        return this.memory[addr & 0xFFFF];
    }

    writeMemory(addr, val) {
        this.memory[addr & 0xFFFF] = val & 0xFF;
    }

    fetch() {
        const byte = this.readMemory(this.registers.pc);
        this.registers.pc = (this.registers.pc + 1) & 0xFFFF;
        return byte;
    }

    fetch16() {
        const low = this.fetch();
        const high = this.fetch();
        return (high << 8) | low;
    }

    push(val) {
        this.registers.sp = (this.registers.sp - 1) & 0xFFFF;
        this.writeMemory(this.registers.sp, (val >> 8) & 0xFF);
        this.registers.sp = (this.registers.sp - 1) & 0xFFFF;
        this.writeMemory(this.registers.sp, val & 0xFF);
    }

    pop() {
        const low = this.readMemory(this.registers.sp);
        this.registers.sp = (this.registers.sp + 1) & 0xFFFF;
        const high = this.readMemory(this.registers.sp);
        this.registers.sp = (this.registers.sp + 1) & 0xFFFF;
        return (high << 8) | low;
    }

    step() {
        if (this.halted) return;
        this.tickDevices();
        const instructionAddress = this.registers.pc;
        const opcode = this.fetch();
        this.lastInstructionAddress = instructionAddress;
        this.execute(opcode, instructionAddress);
        return { address: instructionAddress, opcode };
    }

    execute(opcode, instructionAddress = (this.registers.pc - 1) & 0xFFFF) {
        // MOV
        if (opcode >= 0x40 && opcode <= 0x7F && opcode !== 0x76) {
            this.setRegByCode((opcode >> 3) & 0x07, this.getRegByCode(opcode & 0x07));
            return;
        }
        // MVI
        if ((opcode & 0xC7) === 0x06) {
            this.setRegByCode((opcode >> 3) & 0x07, this.fetch());
            return;
        }
        // ALU Register (ADD, ADC, SUB, SBB, ANA, XRA, ORA, CMP)
        if (opcode >= 0x80 && opcode <= 0xBF) {
            this.executeALU(opcode >> 3 & 0x07, this.getRegByCode(opcode & 0x07));
            return;
        }
        // ALU Immediate
        if ((opcode & 0xC7) === 0xC6) {
            this.executeALU(opcode >> 3 & 0x07, this.fetch());
            return;
        }
        // INR / DCR
        if ((opcode & 0xC7) === 0x04 || (opcode & 0xC7) === 0x05) {
            const reg = (opcode >> 3) & 0x07;
            const val = this.getRegByCode(reg);
            const isDcr = (opcode & 0x07) === 0x05;
            if (isDcr) {
                const res = (val - 1) & 0xFF;
                this.setRegByCode(reg, res);
                this.updateFlags(res);
                this.flags.ac = !((res & 0x0F) === 0x0F); // Equivalent to "not (borrow out of low nibble)"
            } else {
                const res = (val + 1) & 0xFF;
                this.setRegByCode(reg, res);
                this.updateFlags(res);
                this.flags.ac = (val & 0x0F) === 0x0F;
            }
            return;
        }

        switch (opcode) {
            case 0x00: break; // NOP
            case 0x76: this.halted = true; break; // HLT

            case 0x01: this.setRP('bc', this.fetch16()); break;
            case 0x11: this.setRP('de', this.fetch16()); break;
            case 0x21: this.setRP('hl', this.fetch16()); break;
            case 0x31: this.setRP('sp', this.fetch16()); break;

            case 0x3A: this.registers.a = this.readMemory(this.fetch16()); break;
            case 0x32: this.writeMemory(this.fetch16(), this.registers.a); break;
            case 0x2A: { const a = this.fetch16(); this.registers.l = this.readMemory(a); this.registers.h = this.readMemory(a + 1); break; }
            case 0x22: { const a = this.fetch16(); this.writeMemory(a, this.registers.l); this.writeMemory(a + 1, this.registers.h); break; }
            case 0x0A: this.registers.a = this.readMemory(this.getRP('bc')); break;
            case 0x1A: this.registers.a = this.readMemory(this.getRP('de')); break;
            case 0x02: this.writeMemory(this.getRP('bc'), this.registers.a); break;
            case 0x12: this.writeMemory(this.getRP('de'), this.registers.a); break;
            case 0xEB: { const tH = this.registers.h, tL = this.registers.l; this.registers.h = this.registers.d; this.registers.l = this.registers.e; this.registers.d = tH; this.registers.e = tL; break; }

            // INX / DCX / DAD
            case 0x03: this.setRP('bc', this.getRP('bc') + 1); break;
            case 0x13: this.setRP('de', this.getRP('de') + 1); break;
            case 0x23: this.setRP('hl', this.getRP('hl') + 1); break;
            case 0x33: this.setRP('sp', this.getRP('sp') + 1); break;
            case 0x0B: this.setRP('bc', this.getRP('bc') - 1); break;
            case 0x1B: this.setRP('de', this.getRP('de') - 1); break;
            case 0x2B: this.setRP('hl', this.getRP('hl') - 1); break;
            case 0x3B: this.setRP('sp', this.getRP('sp') - 1); break;
            case 0x09: this.dad('bc'); break;
            case 0x19: this.dad('de'); break;
            case 0x29: this.dad('hl'); break;
            case 0x39: this.dad('sp'); break;

            // Branching
            case 0xC3: this.registers.pc = this.fetch16(); break; // JMP
            case 0xC2: this.condJmp(!this.flags.z); break; // JNZ
            case 0xCA: this.condJmp(this.flags.z); break; // JZ
            case 0xD2: this.condJmp(!this.flags.cy); break; // JNC
            case 0xDA: this.condJmp(this.flags.cy); break; // JC
            case 0xE2: this.condJmp(!this.flags.p); break; // JPO
            case 0xEA: this.condJmp(this.flags.p); break; // JPE
            case 0xF2: this.condJmp(!this.flags.s); break; // JP
            case 0xFA: this.condJmp(this.flags.s); break; // JM

            case 0xCD: this.call(this.fetch16()); break; // CALL
            case 0xC4: this.condCall(!this.flags.z); break; // CNZ
            case 0xCC: this.condCall(this.flags.z); break; // CZ
            case 0xD4: this.condCall(!this.flags.cy); break; // CNC
            case 0xDC: this.condCall(this.flags.cy); break; // CC
            case 0xE4: this.condCall(!this.flags.p); break; // CPO
            case 0xEC: this.condCall(this.flags.p); break; // CPE
            case 0xF4: this.condCall(!this.flags.s); break; // CP
            case 0xFC: this.condCall(this.flags.s); break; // CM

            case 0xC9: this.registers.pc = this.pop(); break; // RET
            case 0xC0: if (!this.flags.z) this.registers.pc = this.pop(); break; // RNZ
            case 0xC8: if (this.flags.z) this.registers.pc = this.pop(); break; // RZ
            case 0xD0: if (!this.flags.cy) this.registers.pc = this.pop(); break; // RNC
            case 0xD8: if (this.flags.cy) this.registers.pc = this.pop(); break; // RC
            case 0xE0: if (!this.flags.p) this.registers.pc = this.pop(); break; // RPO
            case 0xE8: if (this.flags.p) this.registers.pc = this.pop(); break; // RPE
            case 0xF0: if (!this.flags.s) this.registers.pc = this.pop(); break; // RP
            case 0xF8: if (this.flags.s) this.registers.pc = this.pop(); break; // RM

            // Stack
            case 0xC5: this.push(this.getRP('bc')); break;
            case 0xD5: this.push(this.getRP('de')); break;
            case 0xE5: this.push(this.getRP('hl')); break;
            case 0xF5: this.push((this.registers.a << 8) | this.getFlagByte()); break; // PUSH PSW
            case 0xC1: this.setRP('bc', this.pop()); break;
            case 0xD1: this.setRP('de', this.pop()); break;
            case 0xE1: this.setRP('hl', this.pop()); break;
            case 0xF1: { const val = this.pop(); this.registers.a = (val >> 8) & 0xFF; this.setFlagByte(val & 0xFF); break; } // POP PSW

            case 0xE3: { const t = this.getRP('hl'); this.registers.l = this.readMemory(this.registers.sp); this.registers.h = this.readMemory(this.registers.sp + 1); this.writeMemory(this.registers.sp, t & 0xFF); this.writeMemory(this.registers.sp + 1, (t >> 8) & 0xFF); break; } // XTHL
            case 0xF9: this.registers.sp = this.getRP('hl'); break; // SPHL
            case 0xE9: this.registers.pc = this.getRP('hl'); break; // PCHL

            // Rotates & Flags
            case 0x07: { const c = (this.registers.a >> 7) & 1; this.registers.a = ((this.registers.a << 1) | c) & 0xFF; this.flags.cy = !!c; break; } // RLC
            case 0x0F: { const c = this.registers.a & 1; this.registers.a = ((this.registers.a >> 1) | (c << 7)) & 0xFF; this.flags.cy = !!c; break; } // RRC
            case 0x17: { const c = this.flags.cy ? 1 : 0; this.flags.cy = !!((this.registers.a >> 7) & 1); this.registers.a = ((this.registers.a << 1) | c) & 0xFF; break; } // RAL
            case 0x1F: { const c = this.flags.cy ? 1 : 0; this.flags.cy = !!(this.registers.a & 1); this.registers.a = ((this.registers.a >> 1) | (c << 7)) & 0xFF; break; } // RAR
            case 0x2F: this.registers.a = (~this.registers.a) & 0xFF; break; // CMA
            case 0x27: this.daa(); break; // DAA
            case 0x37: this.flags.cy = true; break; // STC
            case 0x3F: this.flags.cy = !this.flags.cy; break; // CMC

            // E/S: IN lee el puerto hacia A y OUT escribe A en el puerto.
            case 0xDB: { const port = this.fetch(); this.registers.a = this.readPort(port, instructionAddress); break; }
            case 0xD3: { const port = this.fetch(); this.writePort(port, this.registers.a, instructionAddress); break; }
            case 0xFB: break; // EI
            case 0xF3: break; // DI
        }
    }

    executeALU(op, val) {
        let res;
        switch (op) {
            case 0: // ADD
                res = this.registers.a + val;
                this.flags.cy = res > 0xFF;
                this.flags.ac = (this.registers.a & 0x0F) + (val & 0x0F) > 0x0F;
                this.registers.a = res & 0xFF;
                break;
            case 1: // ADC
                const c = this.flags.cy ? 1 : 0;
                res = this.registers.a + val + c;
                this.flags.cy = res > 0xFF;
                this.flags.ac = (this.registers.a & 0x0F) + (val & 0x0F) + c > 0x0F;
                this.registers.a = res & 0xFF;
                break;
            case 2: // SUB
                res = this.registers.a - val;
                this.flags.cy = res < 0;
                // Intel 8080 logic for auxiliary carry in subtraction:
                // AC is calculated by adding the 4-bit inverted value plus 1
                this.flags.ac = ((this.registers.a & 0x0F) + ((~val) & 0x0F) + 1) > 0x0F;
                this.registers.a = res & 0xFF;
                break;
            case 3: // SBB
                const b = this.flags.cy ? 1 : 0;
                res = this.registers.a - val - b;
                this.flags.cy = res < 0;
                // Low-level addition logic: A + ~val + ~b. ~b is 1 if b=0, and 0 if b=1.
                this.flags.ac = ((this.registers.a & 0x0F) + ((~val) & 0x0F) + (b ? 0 : 1)) > 0x0F;
                this.registers.a = res & 0xFF;
                break;
            case 4: // ANA
                res = this.registers.a & val;
                this.flags.cy = false;
                this.flags.ac = ((this.registers.a | val) & 0x08) !== 0; // 8080 logic
                this.registers.a = res;
                break;
            case 5: // XRA
                res = this.registers.a ^ val;
                this.flags.cy = false;
                this.flags.ac = false;
                this.registers.a = res;
                break;
            case 6: // ORA
                res = this.registers.a | val;
                this.flags.cy = false;
                this.flags.ac = false;
                this.registers.a = res;
                break;
            case 7: // CMP
                res = this.registers.a - val;
                this.flags.cy = res < 0;
                this.flags.ac = ((this.registers.a & 0x0F) + ((~val) & 0x0F) + 1) > 0x0F;
                this.updateFlags(res);
                return;
        }
        this.updateFlags(this.registers.a);
    }

    dad(rp) {
        const val = this.getRP(rp);
        const hl = this.getRP('hl');
        const res = hl + val;
        this.flags.cy = res > 0xFFFF;
        this.setRP('hl', res);
    }

    condJmp(cond) {
        const addr = this.fetch16();
        if (cond) this.registers.pc = addr;
    }

    condCall(cond) {
        const addr = this.fetch16();
        if (cond) this.call(addr);
    }

    call(addr) {
        this.push(this.registers.pc);
        this.registers.pc = addr;
    }

    daa() {
        let res = this.registers.a;
        let correction = 0;
        if ((res & 0x0F) > 0x09 || this.flags.ac) {
            correction |= 0x06;
        }
        if (res > 0x99 || this.flags.cy) {
            correction |= 0x60;
            this.flags.cy = true;
        }
        res += correction;
        this.flags.ac = ((this.registers.a & 0x0F) + (correction & 0x0F)) > 0x0F;
        this.registers.a = res & 0xFF;
        this.updateFlags(this.registers.a);
    }

    getRegByCode(code) {
        switch (code) {
            case 0: return this.registers.b;
            case 1: return this.registers.c;
            case 2: return this.registers.d;
            case 3: return this.registers.e;
            case 4: return this.registers.h;
            case 5: return this.registers.l;
            case 6: return this.readMemory(this.getRP('hl'));
            case 7: return this.registers.a;
        }
    }

    setRegByCode(code, val) {
        val &= 0xFF;
        switch (code) {
            case 0: this.registers.b = val; break;
            case 1: this.registers.c = val; break;
            case 2: this.registers.d = val; break;
            case 3: this.registers.e = val; break;
            case 4: this.registers.h = val; break;
            case 5: this.registers.l = val; break;
            case 6: this.writeMemory(this.getRP('hl'), val); break;
            case 7: this.registers.a = val; break;
        }
    }
}

if (typeof module !== 'undefined') {
    module.exports = Intel8080;
}
