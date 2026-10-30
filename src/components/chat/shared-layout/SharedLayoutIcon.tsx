import {
  ArrowDown,
  ArrowRight,
  BrainCircuit,
  CarFront,
  CheckCircle,
  Film,
  MinusCircle,
  Route,
  ScanEye,
  Waves,
} from "lucide-react";

const icons = {
  "arrow-down": ArrowDown,
  "arrow-right": ArrowRight,
  "brain-circuit": BrainCircuit,
  "car-front": CarFront,
  "check-circle": CheckCircle,
  film: Film,
  "minus-circle": MinusCircle,
  route: Route,
  "scan-eye": ScanEye,
  waves: Waves,
};

export function SharedLayoutIcon({ name }: { name: string }) {
  if (!Object.hasOwn(icons, name)) return null;
  const Icon = icons[name as keyof typeof icons];
  return <Icon aria-hidden="true" />;
}
