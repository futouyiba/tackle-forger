import { MotionCoreDemo } from "../../MotionCoreDemo";
import { notFound } from "next/navigation";
import { isMotionDevelopmentFixtureEnabled } from "@/lib/motion-presentation";

/** Development-only fixture for the #102 playback kernel; not a product route. */
export default function MotionCoreFixturePage() {
  if (!isMotionDevelopmentFixtureEnabled(process.env.NODE_ENV)) notFound();
  return <MotionCoreDemo />;
}
