import { Address, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { Root } from '../wrappers/Root';

export async function run(provider: NetworkProvider) {
    let rootCode = await compile('root');
    let accountCode = await compile('account');
    let questionCode = await compile('question');
    let questionRefCode = await compile('question-ref');

    const root = provider.open(Root.createFromConfig({
            accountCode,
            questionCode,
            questionRefCode
        },
        rootCode));

    console.log("Root address", root.address.toString());
    await root.sendDeploy(provider.sender(), toNano('0.6'), Address.parse('EQAVpcsurdxJO8O-XHng_xXV1I01euhnLNL1ZkPbMPG_vWRb'));
    await provider.waitForDeploy(root.address);
}
