#ifndef INCLUDED_IA32_ASM
#define INCLUDED_IA32_ASM

#ifdef __cplusplus
extern "C" {
#endif

/**
 * prepare ia32_asm_cpuid for use (detects which CPUID functions are
 * available). called by ia32_init.
 **/
extern void ia32_asm_cpuid_init();

/**
 * try to call the specified CPUID sub-function.
 * (note: ECX is set to 0 beforehand as required by sub-function 4)
 * fills register array according to IA32Regs.
 * @return true on success or false if the sub-function isn't supported.
 **/
extern bool ia32_asm_cpuid(u32 func, u32* regs);

/**
 * for all 1-bits in mask, update the corresponding FPU control word bits
 * with the bit values in new_val.
 * @return 0 to indicate success.
 **/
extern uint ia32_asm_control87(uint new_val, uint mask);

/**
 * @return the current value of the TimeStampCounter in edx:eax
 * (interpretable as a u64 when using the standard Win32 calling convention)
 **/
extern u64 ia32_asm_rdtsc_edx_eax(void);

/**
 * write the current execution state (e.g. all register values) into
 * (Win32::CONTEXT*)pcontext (defined as void* to avoid dependency).
 **/
extern void ia32_asm_get_current_context(void* pcontext);


// implementations of the cpu.h interface

/// see cpu_atomic_add
extern void ia32_asm_atomic_add(intptr_t* location, intptr_t increment);

/// see cpu_CAS
extern bool ia32_asm_CAS(uintptr_t* location, uintptr_t expected, uintptr_t new_value);

/// see cpu_i32_from_float
extern i32 ia32_asm_i32_from_float(float f);
extern i32 ia32_asm_i32_from_double(double d);
extern i64 ia32_asm_i64_from_double(double d);


// backends for POSIX/SUS functions

/// see fpclassify
extern uint ia32_asm_fpclassifyd(double d);
extern uint ia32_asm_fpclassifyf(float f);

/// see rintf
extern float ia32_asm_rintf(float);
extern double ia32_asm_rint(double);
extern float ia32_asm_fminf(float, float);
extern float ia32_asm_fmaxf(float, float);


#ifdef __cplusplus
}
#endif

#endif	// #ifndef INCLUDED_IA32_ASM
