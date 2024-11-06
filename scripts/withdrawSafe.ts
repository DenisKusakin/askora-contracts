import { compile, NetworkProvider } from '@ton/blueprint';
import { Root } from '../wrappers/Root';
import { Address } from '@ton/core';

export async function run(provider: NetworkProvider) {
    let rootCode = await compile('root');
    let accountCode = await compile('account');
    let questionCode = await compile('question');
    let questionRefCode = await compile('question-ref');

    // const root = provider.open(Root.createFromConfig({
    //         accountCode,
    //         questionCode,
    //         questionRefCode
    //     },
    //     rootCode));
    const root = provider.open(Root.createFromAddress(Address.parse("EQDBDJbpECe3iJ_0RXWpAxmFEJgyUeoTyBzweYbOM9sCfG14")))

    console.log("Root address", root.address.toString());
    await root.sendWithdrawSafe(provider.sender());
}