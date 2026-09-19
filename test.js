// test.js - Unit tests for Intel 8080 CPU and Assembler
const Intel8080 = require('./cpu.js');
const Assembler8080 = require('./assembler.js');
const FPU8080 = require('./fpu.js');
const examplePrograms = require('./programs.js');
const assert = require('assert');

console.log('--- Running Intel 8080 Emulator & Assembler Tests ---');

// Helper to run a test block and report status
function runTest(name, fn) {
    try {
        fn();
        console.log(`[PASS] ${name}`);
    } catch (e) {
        console.error(`[FAIL] ${name}`);
        console.error(e);
        process.exit(1);
    }
}

runTest('CPU Reset & Initial Values', () => {
    const cpu = new Intel8080();
    assert.strictEqual(cpu.registers.a, 0);
    assert.strictEqual(cpu.registers.b, 0);
    assert.strictEqual(cpu.registers.sp, 0xFFFF);
    assert.strictEqual(cpu.registers.pc, 0);
    assert.strictEqual(cpu.flags.z, false);
    assert.strictEqual(cpu.flags.cy, false);
    assert.strictEqual(cpu.halted, false);
});

runTest('INR / DCR AC Flag Behavior', () => {
    const cpu = new Intel8080();

    // INR 0x0F -> should set AC
    cpu.registers.a = 0x0F;
    cpu.execute(0x3C); // INR A
    assert.strictEqual(cpu.registers.a, 0x10);
    assert.strictEqual(cpu.flags.ac, true, 'INR 0x0F should set AC flag');

    // DCR 0x10 -> should clear AC (as there is a borrow out of low order nibble, complement of borrow is 0)
    cpu.registers.a = 0x10;
    cpu.execute(0x3D); // DCR A
    assert.strictEqual(cpu.registers.a, 0x0F);
    assert.strictEqual(cpu.flags.ac, false, 'DCR 0x10 should clear AC flag');

    // DCR 0x0F -> should set AC (as there is no borrow out of low order nibble, complement of borrow is 1)
    cpu.registers.a = 0x0F;
    cpu.execute(0x3D); // DCR A
    assert.strictEqual(cpu.registers.a, 0x0E);
    assert.strictEqual(cpu.flags.ac, true, 'DCR 0x0F should set AC flag');
});

runTest('Subtraction AC and Carry Flag Logic', () => {
    const cpu = new Intel8080();

    // Test: 0x3E - 0x05 (no borrow)
    cpu.registers.a = 0x3E;
    cpu.executeALU(2, 0x05); // SUB 0x05 (ALU op 2 is SUB)
    assert.strictEqual(cpu.registers.a, 0x39);
    assert.strictEqual(cpu.flags.cy, false);
    // (0x0E & 0x0F) - (0x05 & 0x0F) = 0x0E - 0x05 = 0x09 >= 0, so AC flag calculation should match physical 8080
    // In physical 8080, SUB does: A + ~B + 1.
    // Let's check AC logic: 0x3E + ~0x05 + 1 = 0x3E + 0xFA + 1. Low nibbles: 0x0E + 0x0A + 1 = 0x19 (carry out is 1)
    // Physical 8080 does not invert AC after subtraction, so AC = 1.
    assert.strictEqual(cpu.flags.ac, true, 'SUB 0x3E - 0x05 should result in AC = 1 (since 0x0E + 0x0A + 1 = 0x19)');

    // Test: 0x00 - 0x01
    cpu.reset();
    cpu.registers.a = 0x00;
    cpu.executeALU(2, 0x01); // SUB 0x01
    assert.strictEqual(cpu.registers.a, 0xFF);
    assert.strictEqual(cpu.flags.cy, true, '0x00 - 0x01 should set carry (borrow)');
    // Low nibbles: 0x00 + ~0x01 + 1 = 0x00 + 0x0E + 1 = 0x0F (carry out is 0). Thus AC = 0.
    assert.strictEqual(cpu.flags.ac, false, '0x00 - 0x01 should result in AC = 0');
});

runTest('Rotate Masking (RLC / RAL accumulator 8-bit safety)', () => {
    const cpu = new Intel8080();

    // RLC with MSB set: 0x80 -> should rotate to 0x01, CY = true
    cpu.registers.a = 0x80;
    cpu.execute(0x07); // RLC
    assert.strictEqual(cpu.registers.a, 0x01);
    assert.strictEqual(cpu.flags.cy, true);

    // RAL with MSB set and CY = false: 0x80 -> should rotate to 0x00, CY = true
    cpu.reset();
    cpu.registers.a = 0x80;
    cpu.flags.cy = false;
    cpu.execute(0x17); // RAL
    assert.strictEqual(cpu.registers.a, 0x00);
    assert.strictEqual(cpu.flags.cy, true);
});

runTest('Assembler Supports Pair Names (BC, DE, HL)', () => {
    const assembler = new Assembler8080();
    const source = `
        LXI BC, 1234H
        LXI DE, 5678H
        LXI HL, 9ABCH
    `;
    const result = assembler.assemble(source);
    const bin = result.binary;

    // LXI BC, 1234H -> 01 34 12
    assert.strictEqual(bin[0], 0x01);
    assert.strictEqual(bin[1], 0x34);
    assert.strictEqual(bin[2], 0x12);

    // LXI DE, 5678H -> 11 78 56
    assert.strictEqual(bin[3], 0x11);
    assert.strictEqual(bin[4], 0x78);
    assert.strictEqual(bin[5], 0x56);

    // LXI HL, 9ABCH -> 21 BC 9A
    assert.strictEqual(bin[6], 0x21);
    assert.strictEqual(bin[7], 0xBC);
    assert.strictEqual(bin[8], 0x9A);
});

runTest('Assembler Supports RST 0 - RST 7 Instructions', () => {
    const assembler = new Assembler8080();
    const source = `
        RST 0
        RST 3
        RST 7
    `;
    const result = assembler.assemble(source);
    const bin = result.binary;

    assert.strictEqual(bin[0], 0xC7); // RST 0
    assert.strictEqual(bin[1], 0xDF); // RST 3
    assert.strictEqual(bin[2], 0xFF); // RST 7
});

runTest('Assembler Rejects Invalid Code & Registers', () => {
    const assembler = new Assembler8080();

    // Test invalid register
    assert.throws(() => {
        assembler.assemble('MOV B, X');
    }, /Invalid register/i);

    // Test MOV M, M (illegal instruction on 8080)
    assert.throws(() => {
        assembler.assemble('MOV M, M');
    }, /Cannot use MOV M, M/i);

    // Test undefined labels
    assert.throws(() => {
        assembler.assemble('JMP UNDEFINED_LABEL');
    }, /Undefined label/i);
});

runTest('Assembler acepta IN/OUT decimal y hexadecimal, ORG, DB y etiquetas', () => {
    const assembler = new Assembler8080();
    const result = assembler.assemble(`ORG 0100H
DATOS: DB 01H, 2, 03H
BUCLE: IN 20H
OUT 21
JNZ BUCLE`);
    assert.deepStrictEqual(Array.from(result.binary.slice(0x100, 0x103)), [0x01, 0x02, 0x03]);
    assert.deepStrictEqual(Array.from(result.binary.slice(0x103, 0x108)), [0xDB, 0x20, 0xD3, 0x15, 0xC2]);
    assert.strictEqual(result.binary[0x108], 0x03);
    assert.strictEqual(result.binary[0x109], 0x01);
});

runTest('FPU Encodes 3.5 as IEEE-754 binary32', () => {
    const decoded = FPU8080.decode(3.5);
    assert.strictEqual(decoded.hex, '0x40600000');
    assert.strictEqual(decoded.sign, 0);
    assert.strictEqual(decoded.exponent, 128);
    assert.strictEqual(decoded.unbiasedExponent, 1);
    assert.strictEqual(decoded.mantissaBits, '11000000000000000000000');
});

runTest('FPU Adds operands and returns a rounded binary32 result', () => {
    const result = FPU8080.operate(3.5, 2.25, 'add');
    assert.strictEqual(result.value, 5.75);
    assert.strictEqual(result.hex, '0x40B80000');
    assert.strictEqual(result.bits.length, 32);
});

runTest('FPU Supports subtraction, multiplication and division', () => {
    assert.strictEqual(FPU8080.operate(9, 4, 'subtract').value, 5);
    assert.strictEqual(FPU8080.operate(3, 4, 'multiply').value, 12);
    assert.strictEqual(FPU8080.operate(9, 2, 'divide').value, 4.5);
});

runTest('FPU Applies single-precision rounding', () => {
    const result = FPU8080.operate(0.1, 0.2, 'add');
    assert.strictEqual(result.value, 0.30000001192092896);
    assert.strictEqual(result.hex, '0x3E99999A');
});

runTest('FPU Rejects unknown operations', () => {
    assert.throws(() => FPU8080.operate(1, 2, 'power'), /Unknown FPU operation/);
});

function connectFPU(cpu = new Intel8080(), cycles = 8) {
    const fpu = new FPU8080({ operationCycles: cycles });
    cpu.attachDevice(0x20, fpu.getDataDevice());
    cpu.attachDevice(0x21, fpu.getControlDevice());
    return { cpu, fpu };
}

function pushFloat(fpu, value) {
    const raw = FPU8080.float32ToRaw(value);
    [raw & 0xFF, (raw >>> 8) & 0xFF, (raw >>> 16) & 0xFF, (raw >>> 24) & 0xFF].forEach((byte) => fpu.writeData(byte));
}

function finishFPU(fpu) {
    while (fpu.getSnapshot().busyCycles > 0) fpu.tick();
}

function readFloat(fpu) {
    const bytes = [fpu.readData(), fpu.readData(), fpu.readData(), fpu.readData()];
    const raw = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    return FPU8080.rawToFloat32(raw);
}

function runProgram(source, maxSteps = 10000) {
    const assembler = new Assembler8080();
    const { cpu, fpu } = connectFPU();
    const result = assembler.assemble(source);
    cpu.memory.set(result.binary);
    let steps = 0;
    while (!cpu.halted && steps < maxSteps) { cpu.step(); steps++; }
    assert.ok(cpu.halted, `El programa no terminó en ${maxSteps} pasos (PC=${cpu.registers.pc.toString(16)})`);
    return { cpu, fpu, steps };
}

runTest('CPU IN/OUT usa dispositivos por puerto y devuelve FF si no existe dispositivo', () => {
    const cpu = new Intel8080();
    let written = null;
    cpu.attachDevice(0x10, { read: () => 0xA5, write: (value) => { written = value; } });
    cpu.memory.set([0xDB, 0x10, 0xD3, 0x10, 0xDB, 0x11, 0x76]);
    cpu.step();
    assert.strictEqual(cpu.registers.a, 0xA5);
    cpu.step();
    assert.strictEqual(written, 0xA5);
    cpu.step();
    assert.strictEqual(cpu.registers.a, 0xFF);
});

runTest('FPU transfiere binary32 en little-endian y mantiene BUSY durante 8 ciclos', () => {
    const { cpu, fpu } = connectFPU();
    pushFloat(fpu, 3.5);
    pushFloat(fpu, 2.25);
    assert.deepStrictEqual(fpu.getSnapshot().inputBuffer, []);
    assert.strictEqual(fpu.getSnapshot().stack[1].hex, '0x40600000');
    cpu.writePort(0x21, 0x01);
    assert.strictEqual(fpu.readStatus() & 0x01, 0x01);
    for (let i = 0; i < 7; i++) fpu.tick();
    assert.strictEqual(fpu.readStatus() & 0x01, 0x01);
    fpu.tick();
    assert.strictEqual(fpu.readStatus() & 0x01, 0);
    assert.strictEqual(fpu.readStatus() & 0x02, 0x02);
});

runTest('FPU ejecuta los comandos binarios y unarios', () => {
    const binaryCases = [[0x01, 3.5, 2.25, 5.75], [0x02, 9, 4, 5], [0x03, 3, 4, 12], [0x04, 9, 2, 4.5]];
    binaryCases.forEach(([command, a, b, expected]) => {
        const fpu = new FPU8080();
        pushFloat(fpu, a); pushFloat(fpu, b); fpu.writeCommand(command); finishFPU(fpu);
        assert.strictEqual(fpu.getSnapshot().lastResult.value, expected);
        assert.strictEqual(readFloat(fpu), expected);
    });
    [[0x05, 2, Math.SQRT2], [0x06, 3.5, -3.5], [0x07, -3.5, 3.5]].forEach(([command, value, expected]) => {
        const fpu = new FPU8080(); pushFloat(fpu, value); fpu.writeCommand(command); finishFPU(fpu);
        assert.strictEqual(fpu.getSnapshot().lastResult.value, FPU8080.toFloat32(expected));
    });
});

runTest('FPU ejecuta FCMP, FLD y FXCH sin lanzar excepciones', () => {
    const fpu = new FPU8080();
    pushFloat(fpu, 2); pushFloat(fpu, 3); fpu.writeCommand(0x08); finishFPU(fpu);
    assert.strictEqual(Boolean(fpu.readStatus() & 0x80), true);
    fpu.reset(); pushFloat(fpu, 2); fpu.writeCommand(0x09); finishFPU(fpu);
    assert.strictEqual(fpu.getSnapshot().stack.length, 2);
    fpu.reset(); pushFloat(fpu, 2); pushFloat(fpu, 3); fpu.writeCommand(0x0A); finishFPU(fpu);
    assert.strictEqual(fpu.getSnapshot().stack[0].value, 2);
});

runTest('FPU activa DIV0, INVALID y devuelve resultado sin romper el CPU', () => {
    const fpu = new FPU8080();
    pushFloat(fpu, 1); pushFloat(fpu, 0); fpu.writeCommand(0x04); finishFPU(fpu);
    assert.strictEqual(Boolean(fpu.readStatus() & 0x08), true);
    assert.strictEqual(fpu.getSnapshot().lastResult.hex, '0x7F800000');
    fpu.reset(); pushFloat(fpu, -1); fpu.writeCommand(0x05); finishFPU(fpu);
    assert.strictEqual(Boolean(fpu.readStatus() & 0x04), true);
});

runTest('Los cinco programas FPU ensamblan, sondean BUSY y guardan cuatro bytes', () => {
    const expected = {
        suma: [0x00, 0x00, 0xB8, 0x40],
        circulo: [0xDB, 0x0F, 0x49, 0x41],
        fahrenheit: [0x00, 0x00, 0x9A, 0x42],
        div0: [0x00, 0x00, 0x80, 0x7F],
        raiz: [0xF3, 0x04, 0xB5, 0x3F]
    };
    Object.entries(examplePrograms).forEach(([name, program]) => {
        const { cpu } = runProgram(program.source);
        const bytes = [0, 1, 2, 3].map((offset) => cpu.readMemory(0x2000 + offset));
        assert.deepStrictEqual(bytes, expected[name], `${name}: bytes inesperados ${bytes.map((value) => value.toString(16))}`);
    });
});

console.log('All tests completed successfully!');
