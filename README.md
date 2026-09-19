# Intel 8080 + FPU Lab · Versión 3.0.0

Fork educativo del emulador y ensamblador Intel 8080. Esta versión integra un coprocesador de punto flotante conceptual, conectado al CPU mediante los puertos de E/S del 8080 y modelado con IEEE-754 binary32.

## Ejecutar

El proyecto no usa frameworks, dependencias ni build. Sirve los archivos estáticos desde la raíz:

```powershell
python -m http.server 8000
```

Si Python no está disponible en Windows, puede usarse cualquier servidor estático local o el servidor Node indicado en la documentación de la entrega. Abre `http://localhost:8000`.

Las pruebas unitarias se ejecutan con:

```powershell
node test.js
```

## Integración CPU ↔ FPU

La FPU se conecta como dos dispositivos de puerto:

| Puerto | Dirección | Función |
| --- | --- | --- |
| `20H` | `OUT` | Empuja un byte al buffer del operando. Cada 4 bytes forman un binary32 little-endian. |
| `20H` | `IN` | Extrae un byte del resultado binary32, también little-endian. |
| `21H` | `OUT` | Ejecuta un comando FPU. |
| `21H` | `IN` | Lee el registro de estado. |

Puertos sin dispositivo devuelven `FFH` en `IN` y descartan `OUT`. La API del CPU también permite conectar dispositivos propios:

```javascript
cpu.attachDevice(0x10, {
    read: () => 0xA5,
    write: (value) => console.log(value)
});
```

## Comandos FPU

| Código | Comando | Operación |
| --- | --- | --- |
| `01H` | `FADD` | `Y + X` |
| `02H` | `FSUB` | `Y - X` |
| `03H` | `FMUL` | `Y × X` |
| `04H` | `FDIV` | `Y ÷ X` |
| `05H` | `FSQRT` | `√X` |
| `06H` | `FCHS` | Cambiar signo de `X` |
| `07H` | `FABS` | Valor absoluto de `X` |
| `08H` | `FCMP` | Comparar `Y` con `X` en el estado |
| `09H` | `FLD` | Duplicar el tope de la pila |
| `0AH` | `FXCH` | Intercambiar `X` e `Y` |
| `0FH` | `FCLR` | Limpiar pila, buffers y estado |

La pila tiene los registros conceptuales `X`, `Y`, `Z`, `T` y una profundidad mínima de cuatro valores. Los comandos tardan ocho pasos de CPU; durante ese tiempo `BUSY=1` y el programa debe sondear `IN 21H`.

### Registro de estado

| Bit | Nombre | Significado |
| ---: | --- | --- |
| 0 | `BUSY` | La operación sigue en ejecución. |
| 1 | `READY` | La FPU está lista. |
| 2 | `INVALID` | NaN, raíz negativa, comando o pila inválida. |
| 3 | `DIV0` | División entre cero. |
| 4 | `OVERFLOW` | Desbordamiento a infinito. |
| 5 | `UNDERFLOW` | Resultado no nulo reducido a cero. |
| 6 | `ZERO` | Resultado igual a cero. |
| 7 | `NEG` | Resultado negativo. |

## Programa mínimo: 3.5 + 2.25

Los bytes de `3.5` son `00 00 60 40`; los de `2.25` son `00 00 10 40`. El resultado `5.75` se guarda como `00 00 B8 40` en `2000H–2003H`:

```asm
MVI A, 00H
OUT 20H
OUT 20H
MVI A, 60H
OUT 20H
MVI A, 40H
OUT 20H

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
HLT
```

La interfaz incluye además ejemplos de área de círculo, conversión Celsius/Fahrenheit, división por cero y raíz cuadrada de 2.

## Interfaz y demostración

La interfaz utiliza únicamente el tema `Retro clásico`, inspirado en el panel frontal del Altair 8800, con carcasa beige, tipografía monoespaciada y LEDs rojos. El editor de ensamblador usa un área gris de alto contraste para facilitar la lectura.

La pantalla muestra registros y banderas del 8080 como LEDs binarios, la pila FPU con decimal/hexadecimal/bits, el registro de estado, el monitor de bus, el datapath iluminado durante cada `IN/OUT` y la fase real de la FPU durante `BUSY`.

`Demo guiada` carga la suma de ejemplo y ejecuta el mismo programa instrucción por instrucción; no es una animación independiente. El guion para grabar el video está en [GUION_VIDEO.md](GUION_VIDEO.md).

## Publicación

El proyecto está listo para GitHub Pages porque `index.html` está en la raíz y todas las rutas son relativas. Marcador de URL:

```text
https://<usuario>.github.io/8080emilio/
```

## Licencia

MIT. Este repositorio es un fork educativo del proyecto original y conserva su aviso de licencia.
