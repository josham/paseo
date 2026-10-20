export interface ModelPickHandlers {
  /** Draft composers change provider and model together, in place. */
  onSelectProviderAndModel?: (provider: string, modelId: string) => void;
  /**
   * Live agents cannot change the process they are, so picking another
   * provider's model hands the work to a new agent instead of switching.
   */
  onHandoffToProviderAndModel?: (provider: string, modelId: string) => void;
  onSelectProvider?: (providerId: string) => void;
  onSelectModel?: (modelId: string) => void;
}

export interface ModelPickInput extends ModelPickHandlers {
  nextProviderId: string;
  modelId: string;
  currentProvider: string;
}

export function pickSheetModel(input: ModelPickInput): void {
  if (input.onSelectProviderAndModel) {
    input.onSelectProviderAndModel(input.nextProviderId, input.modelId);
    return;
  }
  if (input.nextProviderId !== input.currentProvider) {
    if (input.onHandoffToProviderAndModel) {
      input.onHandoffToProviderAndModel(input.nextProviderId, input.modelId);
      return;
    }
    input.onSelectProvider?.(input.nextProviderId);
  }
  input.onSelectModel?.(input.modelId);
}

export function pickDesktopModel(input: ModelPickInput): void {
  if (input.onSelectProviderAndModel) {
    input.onSelectProviderAndModel(input.nextProviderId, input.modelId);
    return;
  }
  if (input.nextProviderId === input.currentProvider) {
    input.onSelectModel?.(input.modelId);
    return;
  }
  input.onHandoffToProviderAndModel?.(input.nextProviderId, input.modelId);
}
