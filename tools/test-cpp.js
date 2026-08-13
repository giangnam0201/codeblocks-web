// Smoke tests for the C++ engine.  Run with:  node tools/test-cpp.js
const fs = require('fs');
const path = require('path');
const CPP = eval(fs.readFileSync(path.resolve(__dirname, '..', 'js', 'cpp.js'), 'utf8')
                   .replace('var CPP =', '') + ';');

function run(code, stdin) {
    let out = '';
    const io = { write: s => { out += s; } };
    const res = CPP.compile(code, 'main.cpp');
    if (!res.ok) {
        return { out, err: res.diagnostics.map(d => `${d.line}:${d.col}: ${d.kind}: ${d.message}`).join('\n') };
    }
    const proc = CPP.createProcess(res.program, io);
    proc.interp.input = stdin || '';
    proc.interp.inputClosed = true;
    let step = proc.gen.next();
    let guard = 0;
    try {
        while (!step.done) {
            if (++guard > 5000000) throw new Error('timeout');
            step = proc.gen.next();
        }
    } catch (e) {
        if (e instanceof CPP.ExitSignal) return { out, code: e.code };
        return { out, err: (e.line ? 'line ' + e.line + ': ' : '') + e.message };
    }
    return { out, code: step.value };
}

const tests = [
['hello', `#include <iostream>
using namespace std;
int main(){ cout << "Hello world!" << endl; return 0; }`, '', 'Hello world!\n'],

['cin sum', `#include <iostream>
using namespace std;
int main(){ int a,b; cin>>a>>b; cout<<"sum="<<a+b<<endl; }`, '3 4\n', 'sum=7\n'],

['string', `#include <iostream>
#include <string>
using namespace std;
int main(){ string s="abc"; s+="de"; cout<<s<<" "<<s.size()<<" "<<s.substr(1,3)<<endl; }`, '', 'abcde 5 bcd\n'],

['getline', `#include <iostream>
#include <string>
using namespace std;
int main(){ string line; getline(cin,line); cout<<"["<<line<<"]"<<endl; }`, 'hello world\n', '[hello world]\n'],

['vector', `#include <iostream>
#include <vector>
using namespace std;
int main(){ vector<int> v; for(int i=0;i<5;i++) v.push_back(i*i);
 for(int x : v) cout<<x<<" "; cout<<endl<<v.size()<<endl; }`, '', '0 1 4 9 16 \n5\n'],

['array 2d', `#include <iostream>
using namespace std;
int main(){ int a[3][3]; for(int i=0;i<3;i++)for(int j=0;j<3;j++)a[i][j]=i*3+j;
 for(int i=0;i<3;i++){for(int j=0;j<3;j++)cout<<a[i][j]<<" ";cout<<endl;} }`, '',
 '0 1 2 \n3 4 5 \n6 7 8 \n'],

['recursion', `#include <iostream>
using namespace std;
int fib(int n){ return n<2?n:fib(n-1)+fib(n-2); }
int main(){ cout<<fib(20)<<endl; }`, '', '6765\n'],

['struct', `#include <iostream>
using namespace std;
struct Point { int x, y; Point(int a,int b){x=a;y=b;} int sum(){return x+y;} };
int main(){ Point p(3,4); cout<<p.x<<","<<p.y<<" "<<p.sum()<<endl; }`, '', '3,4 7\n'],

['class methods', `#include <iostream>
#include <string>
using namespace std;
class Account {
  string owner; double balance;
public:
  Account(string o, double b) : owner(o), balance(b) {}
  void deposit(double v){ balance += v; }
  double get() const { return balance; }
  string who(){ return owner; }
};
int main(){ Account a("Nam", 100.5); a.deposit(9.5); cout<<a.who()<<" "<<a.get()<<endl; }`, '',
 'Nam 110\n'],

['sort', `#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;
int main(){ vector<int> v={5,3,9,1}; sort(v.begin(),v.end());
 for(int x:v)cout<<x<<" "; cout<<endl; }`, '', '1 3 5 9 \n'],

['sort lambda', `#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;
int main(){ vector<int> v={5,3,9,1}; sort(v.begin(),v.end(),[](int a,int b){return a>b;});
 for(int x:v)cout<<x<<" "; cout<<endl; }`, '', '9 5 3 1 \n'],

['double fmt', `#include <iostream>
#include <iomanip>
using namespace std;
int main(){ double d=3.14159265; cout<<d<<endl; cout<<fixed<<setprecision(2)<<d<<endl; }`, '',
 '3.14159\n3.14\n'],

['while/switch', `#include <iostream>
using namespace std;
int main(){ int i=0; while(i<3){ switch(i){case 0: cout<<"zero "; break; case 1: cout<<"one "; break;
 default: cout<<"many "; } i++; } cout<<endl; }`, '', 'zero one many \n'],

['printf', `#include <cstdio>
int main(){ printf("%d %5.2f %s|%c|\\n", 42, 3.14159, "ok", 'X'); return 0; }`, '',
 '42  3.14 ok|X|\n'],

['pointers', `#include <iostream>
using namespace std;
void inc(int &x){ x++; }
int main(){ int a=5; int *p=&a; *p=*p+1; inc(a); cout<<a<<" "<<*p<<endl; }`, '', '7 7\n'],

['map', `#include <iostream>
#include <map>
#include <string>
using namespace std;
int main(){ map<string,int> m; m["b"]=2; m["a"]=1; m["a"]++;
 for(auto p : m) cout<<p.first<<"="<<p.second<<" "; cout<<endl; }`, '', 'a=2 b=2 \n'],

['static/global', `#include <iostream>
using namespace std;
int counter = 0;
void bump(){ counter++; }
int main(){ for(int i=0;i<4;i++) bump(); cout<<counter<<endl; }`, '', '4\n'],

['char ops', `#include <iostream>
#include <cctype>
using namespace std;
int main(){ char c='a'; cout<<(char)toupper(c)<<" "<<(int)c<<endl; }`, '', 'A 97\n'],

['do-while + break', `#include <iostream>
using namespace std;
int main(){ int i=0; do { if(i==3) break; cout<<i; i++; } while(i<10); cout<<endl; }`, '', '012\n'],

['error: undeclared', `#include <iostream>
int main(){ std::cout << undefinedVar; }`, '', null],
];

let pass = 0, fail = 0;
for (const [name, code, stdin, expect] of tests) {
    const r = run(code, stdin);
    if (expect === null) {
        if (r.err) { pass++; console.log('  ok   ', name, '->', r.err.split('\n')[0]); }
        else { fail++; console.log('  FAIL ', name, 'expected an error, got', JSON.stringify(r.out)); }
        continue;
    }
    if (r.err) { fail++; console.log('  FAIL ', name, 'ERROR:', r.err); continue; }
    if (r.out !== expect) {
        fail++;
        console.log('  FAIL ', name, '\n        got     ', JSON.stringify(r.out),
                    '\n        expected', JSON.stringify(expect));
        continue;
    }
    pass++;
    console.log('  ok   ', name);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
