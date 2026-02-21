import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options) => useQueryMock(options),
}));

import { useContractRead } from "../hooks/useContractRead";

describe("useContractRead", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({ data: null, isLoading: false, error: null });
  });

  it("passes structuralSharing=false through to React Query options", () => {
    const contract = {
      target: "0x8D186E672026FE39FE3265f9737D8884B4A18604",
      getActiveJobs: vi.fn(),
    };

    useContractRead(contract, "getActiveJobs", [], { structuralSharing: false });

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const options = useQueryMock.mock.calls[0][0];
    expect(options.structuralSharing).toBe(false);
    expect(options.queryKey).toEqual([
      "contract",
      "0x8D186E672026FE39FE3265f9737D8884B4A18604",
      "getActiveJobs",
    ]);
  });

  it("builds a stable query key from target, method, and args", () => {
    const contract = {
      target: "0x8Df5782c83e03488F68f92e87617e8941F602D36",
      getListing: vi.fn(),
    };

    useContractRead(contract, "getListing", [7n, "lending", true]);

    expect(useQueryMock).toHaveBeenCalledTimes(1);
    const options = useQueryMock.mock.calls[0][0];
    expect(options.queryKey).toEqual([
      "contract",
      "0x8Df5782c83e03488F68f92e87617e8941F602D36",
      "getListing",
      7n,
      "lending",
      true,
    ]);
    expect(options.enabled).toBe(true);
  });

  it("queryFn resolves contract method result without mutation", async () => {
    const listingIds = [1n, 2n, 3n];
    const getActiveListings = vi.fn(async (status) => {
      expect(status).toBe("active");
      return listingIds;
    });
    const contract = {
      target: "0x8Df5782c83e03488F68f92e87617e8941F602D36",
      getActiveListings,
    };

    useContractRead(contract, "getActiveListings", ["active"]);

    const options = useQueryMock.mock.calls[0][0];
    const result = await options.queryFn();

    expect(getActiveListings).toHaveBeenCalledWith("active");
    expect(result).toBe(listingIds);
  });
});
