type DeploymentEnvironment = {
  NITRO_PRESET?: string;
  VERCEL?: string;
};

export function isVercelNitroBuild(
  environment: DeploymentEnvironment = process.env as DeploymentEnvironment,
): boolean {
  return (
    environment.VERCEL === "1" || environment.NITRO_PRESET === "vercel"
  );
}
