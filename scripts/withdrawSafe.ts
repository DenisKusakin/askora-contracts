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
    const root = provider.open(Root.createFromAddress(Address.parse("EQDEIlBiakOObFk1BEOwFD8Xn3jtnr0qaYnMIgQAvNTlX-_x")))

    console.log("Root address", root.address.toString());
    await root.sendWithdrawSafe(provider.sender());
}