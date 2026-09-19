# Guía didáctica · Intel 8080 y coprocesador FPU

## 1. Flujo de trabajo

1. Selecciona un programa de ejemplo en `[ ENSAMBLADOR 8080 ]`.
2. Presiona `Ensamblar y cargar`.
3. Usa `Paso` para observar una instrucción o `Ejecutar` para correr el programa.
4. Revisa los LEDs de registros, el contador `PC`, la memoria y el monitor `[ MONITOR DE BUS / E/S ]`.
5. El botón `Demo guiada` carga la suma de `3.5 + 2.25` y avanza la misma secuencia de instrucciones lentamente.

## 2. Cómo se conecta la FPU

El Intel 8080 no incorpora una ALU de punto flotante. En este fork, el coprocesador se modela como un dispositivo externo conectado al espacio de E/S:

```text
8080 -- OUT 20H / IN 20H -- bus de datos -- FPU -- RAM
     -- OUT 21H / IN 21H -- comando y estado
```

`cpu.attachDevice(port, device)` registra el dispositivo. `IN` lee `device.read()` hacia `A`; `OUT` entrega el valor de `A` a `device.write(value)`. Un puerto sin dispositivo devuelve `FFH` en `IN` y descarta `OUT`.

## 3. Transferencia binary32

Cada operando se envía como cuatro bytes IEEE-754 de precisión simple, menos significativo primero. Por ejemplo:

```text
3.5 = 40600000H = 00 00 60 40
2.25 = 40100000H = 00 00 10 40
5.75 = 40B80000H = 00 00 B8 40
```

Los cuatro `OUT 20H` forman un valor y lo empujan a la pila interna. Los cuatro `IN 20H` siguientes extraen el resultado desde el byte bajo hasta el byte alto.

## 4. Comandos y sondeo BUSY

| Código | Instrucción | Descripción |
| --- | --- | --- |
| `01H` | FADD | `Y + X` |
| `02H` | FSUB | `Y - X` |
| `03H` | FMUL | `Y × X` |
| `04H` | FDIV | `Y ÷ X` |
| `05H` | FSQRT | `√X` |
| `06H` | FCHS | `-X` |
| `07H` | FABS | `abs(X)` |
| `08H` | FCMP | Comparación en banderas |
| `09H` | FLD | Duplica `X` |
| `0AH` | FXCH | Intercambia `X` e `Y` |
| `0FH` | FCLR | Limpia la FPU |

La orden se envía por `OUT 21H`. Como la FPU tarda ocho ciclos, un programa debe esperar:

```asm
MVI A, 01H
OUT 21H
ESPERA:
IN 21H
ANI 01H
JNZ ESPERA
```

El registro de estado es `IN 21H`: bit 0 `BUSY`, bit 1 `READY`, bit 2 `INVALID`, bit 3 `DIV0`, bit 4 `OVERFLOW`, bit 5 `UNDERFLOW`, bit 6 `ZERO` y bit 7 `NEG`.

## 5. Ejemplo de división por cero

Carga `1.0` (`00 00 80 3F`) y `0.0` (`00 00 00 00`), ejecuta `FDIV` (`04H`) y sondea `BUSY`. El resultado es infinito positivo (`0x7F800000`) y el LED `DIV0` queda activo. El CPU continúa ejecutando; el dispositivo no lanza una excepción JavaScript.

## 6. Tema y accesibilidad

La interfaz utiliza únicamente el tema `Retro clásico`, inspirado en el panel frontal del Altair 8800. El editor de ensamblador se muestra en gris para mejorar el contraste con el código. El CSS incluye foco visible, etiquetas ARIA en LEDs y adaptación para móvil. `prefers-reduced-motion` reduce las animaciones.

## 7. Verificación

Desde la raíz del proyecto:

```powershell
node test.js
python -m http.server 8000
```

Las pruebas verifican el CPU, el ensamblador, IN/OUT, puertos sin dispositivo, el formato little-endian, el sondeo BUSY, todos los comandos FPU, errores y los cinco programas de ejemplo.
