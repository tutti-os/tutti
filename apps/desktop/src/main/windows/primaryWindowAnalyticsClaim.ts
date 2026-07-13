export interface PrimaryWindowAnalyticsClaim {
  claim(): boolean;
}

export function createPrimaryWindowAnalyticsClaim(): PrimaryWindowAnalyticsClaim {
  let claimed = false;

  return {
    claim() {
      if (claimed) {
        return false;
      }
      claimed = true;
      return true;
    }
  };
}
