// Compatibility import path for the original EasyEDA routing workflow.
// New integrations should import the concrete Provider implementation directly.
export {digest,prepareNativeSource,executeNative,activeWindow,legacySnapshot,updateBoardSnapshot} from '../providers/easyeda-pro/routing-provider.mjs';
