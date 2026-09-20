import {compileSemanticLayoutFixture} from './fixture';
import SemanticLayoutPreview from './preview';

export default function SemanticLayoutPage() {
  const compiled=compileSemanticLayoutFixture();
  return <SemanticLayoutPreview blueprint={compiled.value} adjustments={compiled.adjustments.map(a=>`${a.path}: ${a.reason}`)}/>;
}
