const banner = "geas-agent online — scaffold only";

export function getBanner(): string {
  return banner;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(getBanner());
}
