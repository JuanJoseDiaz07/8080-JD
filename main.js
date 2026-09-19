/* Interfaz: el único camino para la FPU pasa por los puertos 20H y 21H. */
const cpu = new Intel8080();
const assembler = new Assembler8080();
const fpu = new FloatingPointCoprocessor({ operationCycles: 8 });
cpu.attachDevice(0x20, fpu.getDataDevice());
cpu.attachDevice(0x21, fpu.getControlDevice());

let runInterval = null;
let demoInterval = null;
let memoryStart = 0;
let demoActive = false;
const ioLog = [];

const PROGRAMS_FALLBACK = {
    suma: {
        nombre: 'Suma flotante · 3.5 + 2.25',
        source: `ORG 0000H
; 3.5 = 40600000H -> 00 00 60 40
MVI A, 00H
OUT 20H
OUT 20H
MVI A, 60H
OUT 20H
MVI A, 40H
OUT 20H
; 2.25 = 40100000H -> 00 00 10 40
MVI A, 00H
OUT 20H
OUT 20H
MVI A, 10H
OUT 20H
MVI A, 40H
OUT 20H
MVI A, 01H
OUT 21H
ESPERA:
IN 21H
ANI 01H
JNZ ESPERA
IN 20H
STA 2000H
IN 20H
STA 2001H
IN 20H
STA 2002H
IN 20H
STA 2003H
HLT`
    },
    circulo: {
        nombre: 'Área de círculo · π × r², r = 2',
        source: `ORG 0000H
; 2.0 = 40000000H
MVI A, 00H
OUT 20H
OUT 20H
OUT 20H
MVI A, 40H
OUT 20H
; segundo 2.0
MVI A, 00H
OUT 20H
OUT 20H
OUT 20H
MVI A, 40H
OUT 20H
MVI A, 03H
OUT 21H
ESPERA1:
IN 21H
ANI 01H
JNZ ESPERA1
; pi = 40490FDBH
MVI A, DBH
OUT 20H
MVI A, 0FH
OUT 20H
MVI A, 49H
OUT 20H
MVI A, 40H
OUT 20H
MVI A, 03H
OUT 21H
ESPERA:
IN 21H
ANI 01H
JNZ ESPERA
IN 20H
STA 2000H
IN 20H
STA 2001H
IN 20H
STA 2002H
IN 20H
STA 2003H
HLT`
    },
    fahrenheit: {
        nombre: 'Conversión · 25 °C a °F',
        source: `ORG 0000H
; F = (C x 9 / 5) + 32
; 25.0 = 41C80000H
MVI A, 00H
OUT 20H
OUT 20H
MVI A, C8H
OUT 20H
MVI A, 41H
OUT 20H
; 9.0 = 41100000H
MVI A, 00H
OUT 20H
OUT 20H
MVI A, 10H
OUT 20H
MVI A, 41H
OUT 20H
MVI A, 03H
OUT 21H
ESPERA1:
IN 21H
ANI 01H
JNZ ESPERA1
; 5.0 = 40A00000H
MVI A, 00H
OUT 20H
OUT 20H
MVI A, A0H
OUT 20H
MVI A, 40H
OUT 20H
MVI A, 04H
OUT 21H
ESPERA2:
IN 21H
ANI 01H
JNZ ESPERA2
; 32.0 = 42000000H
MVI A, 00H
OUT 20H
OUT 20H
OUT 20H
MVI A, 42H
OUT 20H
MVI A, 01H
OUT 21H
ESPERA3:
IN 21H
ANI 01H
JNZ ESPERA3
IN 20H
STA 2000H
IN 20H
STA 2001H
IN 20H
STA 2002H
IN 20H
STA 2003H
HLT`
    },
    div0: {
        nombre: 'Error · división entre cero',
        source: `ORG 0000H
; 1.0 = 3F800000H
MVI A, 00H
OUT 20H
OUT 20H
MVI A, 80H
OUT 20H
MVI A, 3FH
OUT 20H
; 0.0 = 00000000H
MVI A, 00H
OUT 20H
OUT 20H
OUT 20H
OUT 20H
MVI A, 04H
OUT 21H
ESPERA:
IN 21H
ANI 01H
JNZ ESPERA
IN 20H
STA 2000H
IN 20H
STA 2001H
IN 20H
STA 2002H
IN 20H
STA 2003H
HLT`
    },
    raiz: {
        nombre: 'Raíz cuadrada · √2',
        source: `ORG 0000H
; 2.0 = 40000000H
MVI A, 00H
OUT 20H
OUT 20H
OUT 20H
MVI A, 40H
OUT 20H
MVI A, 05H
OUT 21H
ESPERA:
IN 21H
ANI 01H
JNZ ESPERA
IN 20H
STA 2000H
IN 20H
STA 2001H
IN 20H
STA 2002H
IN 20H
STA 2003H
HLT`
    }
};

const PROGRAMS = typeof FPU_EXAMPLE_PROGRAMS !== 'undefined' ? FPU_EXAMPLE_PROGRAMS : PROGRAMS_FALLBACK;
const COMMANDS = { add: 0x01, subtract: 0x02, multiply: 0x03, divide: 0x04, sqrt: 0x05, chs: 0x06, abs: 0x07 };
const PHASES = { idle: 'En espera', unpack: 'Desempaquetar', align: 'Alinear exponentes', operate: 'Operar mantisas', normalize: 'Normalizar', round: 'Redondear / empaquetar', ready: 'Resultado listo', error: 'Error' };

function hex(value, length = 2) { return Number(value).toString(16).toUpperCase().padStart(length, '0'); }
function formatValue(value) { return Number.isNaN(value) ? 'NaN' : Number.isFinite(value) ? String(value) : (value < 0 ? '-∞' : '∞'); }
function rawBytes(value) { const raw = FloatingPointCoprocessor.float32ToRaw(value); return [raw & 0xFF, (raw >>> 8) & 0xFF, (raw >>> 16) & 0xFF, (raw >>> 24) & 0xFF]; }
function rawFromBytes(bytes) { return ((bytes[0] || 0) | ((bytes[1] || 0) << 8) | ((bytes[2] || 0) << 16) | ((bytes[3] || 0) << 24)) >>> 0; }

function updateUI() {
    const registers = ['a', 'b', 'c', 'd', 'e', 'h', 'l'];
    registers.forEach((name) => {
        const value = cpu.registers[name];
        const valueNode = document.getElementById(`reg-${name}`);
        const bitsNode = document.getElementById(`bits-${name}`);
        if (valueNode) valueNode.textContent = hex(value);
        if (bitsNode) bitsNode.innerHTML = ledBits(value, 8);
    });
    ['pc', 'sp'].forEach((name) => {
        const value = cpu.registers[name];
        const valueNode = document.getElementById(`reg-${name}`);
        const bitsNode = document.getElementById(`bits-${name}`);
        if (valueNode) valueNode.textContent = hex(value, 4);
        if (bitsNode) bitsNode.innerHTML = ledBits(value, 16);
    });
    const flagByte = document.getElementById('reg-f');
    if (flagByte) flagByte.textContent = hex(cpu.getFlagByte());
    const cpuFlags = { s: cpu.flags.s, z: cpu.flags.z, ac: cpu.flags.ac, p: cpu.flags.p, cy: cpu.flags.cy };
    Object.entries(cpuFlags).forEach(([name, value]) => setLed(`cpu-${name}`, value));
    const status = document.getElementById('status-badge');
    if (status) status.textContent = cpu.halted ? 'DETENIDO' : runInterval ? 'EJECUTANDO' : 'EN ESPERA';
    renderMemory();
    renderStack();
    renderFPU(fpu.getSnapshot());
}

function ledBits(value, width) { return Array.from({ length: width }, (_, index) => `<i class="binary-led ${value & (1 << (width - index - 1)) ? 'on' : ''}" aria-hidden="true"></i>`).join(''); }
function setLed(id, active) { const node = document.querySelector(`[data-led="${id}"]`); if (node) { node.classList.toggle('on', Boolean(active)); node.setAttribute('aria-checked', Boolean(active)); } }

function renderMemory() {
    const table = document.getElementById('memory-table');
    if (!table) return;
    table.innerHTML = '';
    table.appendChild(Object.assign(document.createElement('div'), { className: 'mem-cell mem-header', textContent: '' }));
    for (let i = 0; i < 16; i++) table.appendChild(Object.assign(document.createElement('div'), { className: 'mem-cell mem-header', textContent: hex(i) }));
    for (let row = 0; row < 8; row++) {
        const address = (memoryStart + row * 16) & 0xFFFF;
        table.appendChild(Object.assign(document.createElement('div'), { className: 'mem-cell mem-addr', textContent: hex(address, 4) }));
        for (let col = 0; col < 16; col++) {
            const cell = (address + col) & 0xFFFF;
            const node = Object.assign(document.createElement('div'), { className: 'mem-cell', textContent: hex(cpu.readMemory(cell)) });
            if (cell === cpu.registers.pc) node.classList.add('pc-cell');
            table.appendChild(node);
        }
    }
}

function renderStack() {
    const table = document.getElementById('stack-table');
    if (!table) return;
    table.innerHTML = '';
    for (let offset = 6; offset >= -4; offset -= 2) {
        const address = (cpu.registers.sp + offset) & 0xFFFF;
        const low = cpu.readMemory(address);
        const high = cpu.readMemory((address + 1) & 0xFFFF);
        const row = document.createElement('div');
        row.className = `stack-row ${offset === 0 ? 'active' : ''}`;
        row.innerHTML = `<span>${offset === 0 ? 'SP → ' : ''}${hex(address, 4)}H</span><b>${hex((high << 8) | low, 4)}H</b>`;
        table.appendChild(row);
    }
}

function renderFPU(snapshot) {
    const stack = document.getElementById('fpu-stack');
    if (stack) {
        const names = ['X', 'Y', 'Z', 'T'];
        stack.innerHTML = names.map((name, index) => {
            const item = snapshot.stack[index];
            return `<div class="fpu-stack-row ${item ? 'filled' : ''}"><strong>${name}</strong>${item ? `<span>${formatValue(item.value)}</span><code>${item.hex}</code><small>${item.bits}</small>` : '<span>vacío</span><code>--------</code><small>--------------------------------</small>'}</div>`;
        }).join('');
    }
    Object.entries(snapshot.flags).forEach(([name, active]) => setLed(`fpu-${name}`, active));
    const state = document.getElementById('fpu-status-value');
    if (state) state.textContent = `${PHASES[snapshot.phase] || snapshot.phase} · ${hex(snapshot.status)}H`;
    const phase = document.getElementById('fpu-phase');
    if (phase) phase.textContent = PHASES[snapshot.phase] || snapshot.phase;
    const cycles = document.getElementById('fpu-cycles');
    if (cycles) cycles.textContent = snapshot.busyCycles > 0 ? `${snapshot.busyCycles} ciclos restantes` : '0 ciclos';
}

function logIO(event) {
    ioLog.unshift(event);
    if (ioLog.length > 40) ioLog.pop();
    const log = document.getElementById('io-log');
    if (!log) return;
    log.innerHTML = ioLog.map((item) => `<div class="io-row"><code>${hex(item.address, 4)}H</code><b>${item.direction}</b><code>${hex(item.port)}H</code><span>${item.direction === 'OUT' ? '←' : '→'} ${hex(item.value)}H</span></div>`).join('');
}

function highlightPath(event) {
    document.querySelectorAll('[data-path]').forEach((node) => node.classList.remove('active'));
    const paths = event.port === 0x20 ? ['path-cpu', 'path-bus', 'path-fpu', 'path-ram'] : ['path-cpu', 'path-bus', 'path-fpu'];
    paths.forEach((id) => document.querySelector(`[data-path="${id}"]`)?.classList.add('active'));
    window.setTimeout(() => paths.forEach((id) => document.querySelector(`[data-path="${id}"]`)?.classList.remove('active')), 350);
}

function assembleProgram(source = document.getElementById('code-editor').value) {
    stopExecution();
    try {
        const result = assembler.assemble(source);
        cpu.reset();
        cpu.memory.set(result.binary);
        ioLog.length = 0;
        document.getElementById('assembler-output').textContent = `Programa cargado: ${result.maxAddr.toString(16).toUpperCase()}H bytes usados.`;
        document.getElementById('assembler-output').className = 'success';
        updateUI();
        return true;
    } catch (error) {
        const output = document.getElementById('assembler-output');
        output.textContent = `Error de ensamblado: ${error.message}`;
        output.className = 'error';
        return false;
    }
}

function stepCPU() {
    if (!cpu.halted) cpu.step();
    updateUI();
    if (cpu.halted) stopExecution();
}

function runExecution() {
    if (runInterval) return;
    const speed = Number(document.getElementById('speed-select')?.value || 12);
    runInterval = window.setInterval(() => { for (let i = 0; i < speed && !cpu.halted; i++) cpu.step(); updateUI(); if (cpu.halted) stopExecution(); }, 35);
    updateUI();
}

function stopExecution() {
    if (runInterval) window.clearInterval(runInterval);
    runInterval = null;
    if (demoInterval) window.clearInterval(demoInterval);
    demoInterval = null;
    demoActive = false;
    updateUI();
}

function startDemo() {
    const select = document.getElementById('program-select');
    select.value = 'suma';
    document.getElementById('code-editor').value = PROGRAMS.suma.source;
    if (!assembleProgram(PROGRAMS.suma.source)) return;
    demoActive = true;
    const demoText = document.getElementById('demo-narration');
    if (demoText) demoText.textContent = 'Demo: el programa carga 3.5 y 2.25 en la FPU por OUT 20H.';
    const speed = Number(document.getElementById('speed-select')?.value || 1);
    demoInterval = window.setInterval(() => {
        if (cpu.halted) { stopExecution(); return; }
        cpu.step();
        updateUI();
        if (demoText) demoText.textContent = narrationForState();
    }, Math.max(80, 500 / speed));
}

function narrationForState() {
    const snapshot = fpu.getSnapshot();
    if (snapshot.flags.busy) return `Demo: la FPU está ocupada; el CPU sondea BUSY. Fase: ${PHASES[snapshot.phase]}.`;
    if (snapshot.lastResult) return `Demo: resultado listo (${formatValue(snapshot.lastResult.value)}); el CPU lo lee byte a byte por IN 20H.`;
    return 'Demo: el CPU ejecuta la siguiente instrucción del programa de suma.';
}

function executeManualThroughPorts() {
    const a = Number(document.getElementById('manual-a').value);
    const b = Number(document.getElementById('manual-b').value);
    const command = COMMANDS[document.getElementById('manual-operation').value];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    fpu.reset();
    [...rawBytes(a), ...rawBytes(b)].forEach((value) => cpu.writePort(0x20, value));
    cpu.writePort(0x21, command);
    while (fpu.getSnapshot().busyCycles > 0) fpu.tick();
    const bytes = [cpu.readPort(0x20), cpu.readPort(0x20), cpu.readPort(0x20), cpu.readPort(0x20)];
    const result = FloatingPointCoprocessor.decode(FloatingPointCoprocessor.rawToFloat32(rawFromBytes(bytes)));
    document.getElementById('manual-result').textContent = `${formatValue(result.value)} · ${result.hex}`;
    updateUI();
}

function bindUI() {
    const programSelect = document.getElementById('program-select');
    Object.entries(PROGRAMS).forEach(([key, program]) => programSelect.appendChild(new Option(program.nombre, key)));
    programSelect.addEventListener('change', () => { document.getElementById('code-editor').value = PROGRAMS[programSelect.value].source; });
    document.getElementById('btn-assemble').addEventListener('click', () => assembleProgram());
    document.getElementById('btn-run').addEventListener('click', runExecution);
    document.getElementById('btn-stop').addEventListener('click', stopExecution);
    document.getElementById('btn-step').addEventListener('click', stepCPU);
    document.getElementById('btn-reset').addEventListener('click', () => { stopExecution(); cpu.reset(); ioLog.length = 0; updateUI(); });
    document.getElementById('btn-demo').addEventListener('click', startDemo);
    document.getElementById('btn-demo-next').addEventListener('click', () => { if (!demoActive) assembleProgram(document.getElementById('code-editor').value); stepCPU(); });
    document.getElementById('btn-mem-go').addEventListener('click', () => { memoryStart = parseInt(document.getElementById('mem-start-addr').value, 16) || 0; renderMemory(); });
    document.getElementById('manual-run').addEventListener('click', executeManualThroughPorts);
    document.getElementById('code-editor').value = PROGRAMS.suma.source;
}

cpu.onIO((event) => { logIO(event); highlightPath(event); });
fpu.onEvent((event) => { renderFPU(event.snapshot); const demoText = document.getElementById('demo-narration'); if (demoActive && demoText && event.type === 'command') demoText.textContent = `Demo: comando ${hex(event.command)}H enviado a la FPU; comienza BUSY.`; });

document.addEventListener('DOMContentLoaded', () => { bindUI(); updateUI(); });
