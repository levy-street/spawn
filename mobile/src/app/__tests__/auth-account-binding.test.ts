import { createDeviceIdentityAccountBinding } from "@/lib/auth-gate";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

describe("authenticated device identity binding", () => {
  it("selects me.user.id once and clears it on logout or a 401 transition", () => {
    const setAccount = jest.fn();
    const clearAccount = jest.fn();
    const binding = createDeviceIdentityAccountBinding({ setAccount, clearAccount });

    expect(binding.reconcile(ACCOUNT_A)).toBe(true);
    expect(binding.reconcile(ACCOUNT_A)).toBe(true);
    expect(setAccount).toHaveBeenCalledTimes(1);

    expect(binding.reconcile(null)).toBe(false);
    expect(clearAccount).toHaveBeenCalledTimes(1);
  });

  it("clears A before selecting B without resetting either stored identity", () => {
    const calls: string[] = [];
    const binding = createDeviceIdentityAccountBinding({
      setAccount: (accountId) => calls.push(`set:${accountId}`),
      clearAccount: () => calls.push("clear"),
    });

    binding.reconcile(ACCOUNT_A);
    binding.reconcile(ACCOUNT_B);

    expect(calls).toEqual([`set:${ACCOUNT_A}`, "clear", `set:${ACCOUNT_B}`]);
  });

  it("does not permit signing until account selection has completed", () => {
    let selectedAccount: string | null = null;
    const binding = createDeviceIdentityAccountBinding({
      setAccount: (accountId) => {
        selectedAccount = accountId;
      },
      clearAccount: () => {
        selectedAccount = null;
      },
    });
    const sign = () => {
      if (selectedAccount === null) throw new Error("IDENTITY_ABSENT");
      return selectedAccount;
    };

    expect(sign).toThrow("IDENTITY_ABSENT");
    expect(binding.reconcile(ACCOUNT_A)).toBe(true);
    expect(sign()).toBe(ACCOUNT_A);
  });
});
