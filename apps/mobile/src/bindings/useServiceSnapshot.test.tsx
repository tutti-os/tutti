import { act, create } from "react-test-renderer";
import { Text } from "react-native";
import { ObservableService } from "../services/observableService";
import { useServiceSnapshot } from "./useServiceSnapshot";

class CounterService extends ObservableService<number> {
  private value = 0;

  getSnapshot = (): number => this.value;

  increment(): void {
    this.value += 1;
    this.emitChange();
  }
}

test("useServiceSnapshot renders the service snapshot without copying it", () => {
  const service = new CounterService();
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Counter service={service} />);
  });
  expect(renderer!.root.findByType(Text).props.children).toBe(0);

  act(() => service.increment());
  expect(renderer!.root.findByType(Text).props.children).toBe(1);
});

function Counter({ service }: { service: CounterService }) {
  return <Text>{useServiceSnapshot(service)}</Text>;
}
